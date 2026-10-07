import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import {
  BullRegistrar,
  Processor,
  WorkerHost,
  getQueueToken,
} from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';
import { TalentExtractionService } from '@aramo/talent-extraction';

import { RESUME_EXTRACTION_DRAFT_QUEUE_NAME } from '../resume-extraction-draft/resume-extraction-draft.queue.constants.js';

import {
  TALENT_INTAKE_EXTRACT_JOB_NAME,
  TALENT_INTAKE_RELAY_BATCH_SIZE,
  TALENT_INTAKE_RELAY_QUEUE_NAME,
  intakeExtractJobId,
} from './talent-intake.constants.js';

// Durable Async Talent Intake — the transactional-outbox → BullMQ relay.
//
// complete-upload commits a TalentIntakeDraft (QUEUED) + a TalentIntakeOutboxEvent
// in ONE DB transaction (no Redis dependency). This scheduled relay drains the
// unpublished outbox rows and enqueues an idempotent extraction job onto the
// existing resume-extraction-draft worker queue, then marks the row published —
// but ONLY after the enqueue resolves, so a Redis failure leaves the row
// retryable. The BullMQ job id is derived from the outbox event id, so relay
// replay cannot create a duplicate expensive extraction job.
//
// Lifecycle mirrors ResumeReindexProcessor / ResumeExtractionDraftProcessor
// (ADR-0018 Decision 1): manualRegistration + onApplicationBootstrap gate on
// RedisConnectionConfig.isConfigured. The proof exercises drainOutboxBatch
// directly — no live worker needed.

export interface TalentIntakeRelayTickInput {
  override_batch_size?: number;
}

export interface RelayDrainResult {
  attempted: number;
  enqueued: number;
  published: number;
}

@Processor(TALENT_INTAKE_RELAY_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class TalentIntakeRelayProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly talentExtraction: TalentExtractionService,
    @Inject(getQueueToken(RESUME_EXTRACTION_DRAFT_QUEUE_NAME))
    private readonly extractionQueue: Queue,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('TalentIntakeRelayProcessorLogger')
    private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(job: Job<TalentIntakeRelayTickInput>): Promise<void> {
    const limit = job.data.override_batch_size ?? TALENT_INTAKE_RELAY_BATCH_SIZE;
    const result = await this.drainOutboxBatch({ limit });
    this.logger.log({
      event: 'talent_intake_relay_tick_completed',
      job_id: job.id ?? null,
      attempted: result.attempted,
      enqueued: result.enqueued,
      published: result.published,
    });
  }

  // Exposed for the integration proof — exercises the relay end-to-end without a
  // live BullMQ worker (the resume-reindex precedent).
  async drainOutboxBatch(args: { limit: number }): Promise<RelayDrainResult> {
    const events = await this.talentExtraction.findUnpublishedTalentIntakeOutboxEvents({
      limit: args.limit,
    });
    let enqueued = 0;
    const publishedIds: string[] = [];

    for (const event of events) {
      const payload = (event.event_payload ?? {}) as {
        draft_id?: string;
        correlation_id?: string;
      };
      if (payload.draft_id === undefined) {
        // Malformed payload — publish to stop reprocessing; nothing to enqueue.
        publishedIds.push(event.id);
        this.logger.warn({
          event: 'talent_intake_relay_payload_invalid',
          outbox_event_id: event.id,
        });
        continue;
      }
      const jobId = intakeExtractJobId(event.id);
      try {
        // outbox event id → deterministic BullMQ job id (replay-idempotent).
        await this.extractionQueue.add(
          TALENT_INTAKE_EXTRACT_JOB_NAME,
          {
            draft_id: payload.draft_id,
            tenant_id: event.tenant_id,
            correlation_id: payload.correlation_id ?? null,
          },
          { jobId, removeOnComplete: true, removeOnFail: 1000 },
        );
        enqueued += 1;
        // Publish ONLY after a successful enqueue. Linkage log for traceability.
        publishedIds.push(event.id);
        this.logger.log({
          event: 'talent_intake_relay_enqueued',
          outbox_event_id: event.id,
          draft_id: payload.draft_id,
          tenant_id: event.tenant_id,
          job_id: jobId,
          correlation_id: payload.correlation_id ?? null,
        });
      } catch (err: unknown) {
        // Enqueue failed (Redis) → leave this row unpublished → retried next
        // tick. The derived job id keeps the re-enqueue idempotent.
        this.logger.warn({
          event: 'talent_intake_relay_enqueue_failed',
          outbox_event_id: event.id,
          reason: err instanceof Error ? err.message : 'unknown',
        });
      }
    }

    const published = await this.talentExtraction.markTalentIntakeOutboxPublished({
      event_ids: publishedIds,
      published_at: new Date(),
    });
    return { attempted: events.length, enqueued, published };
  }

  onApplicationBootstrap(): void {
    if (!this.redisConfig.isConfigured) {
      this.logger.warn({
        event: 'talent_intake_relay_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
