import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AramoError, type AramoLogger, RedisConnectionConfig } from '@aramo/common';

import { CanonicalizationRepository } from './canonicalization.repository.js';
import { CanonicalizationService } from './canonicalization.service.js';
import {
  CANONICALIZATION_TRIGGER_BATCH_SIZE,
  CANONICALIZATION_TRIGGER_QUEUE_NAME,
} from './canonicalization-trigger.queue.constants.js';

// T2-3 — production trigger from ingestion → canonicalization.
//
// Design (Lead-reviewable SPLIT — the polling-outbox shape, the
// simplest substrate-aligned variant of the §3 outbox-driven option):
//
//   - The unresolved RawPayloadReference row (resolved_talent_id IS NULL)
//     IS the trigger's "work-to-do" signal. No separate
//     ingestion.OutboxEvent table is needed — the existing
//     resolved_talent_id field (added by T2-2a) already encodes both
//     "needs canonicalize" (NULL) and "canonicalized" (non-NULL).
//
//   - Each tick: fetch up to N unresolved payloads (oldest first),
//     invoke CanonicalizationService.canonicalize() per row with
//     core_talent_id + resolution_method OMITTED so the inline T2-1
//     resolver runs (verified-email match → existing Talent + new
//     overlay; no match → CREATE-NEW).
//
//   - Durability: a failed canonicalize leaves resolved_talent_id NULL;
//     the next tick re-picks the row. A payload is NEVER lost on
//     canonicalization failure (per-payload errors are caught + logged
//     so one bad payload does not abort the whole tick — mirrors
//     OutboxPublisherProcessor.drainSchema's per-schema isolation).
//
//   - Idempotency: two layers — (a) the polling query filters out
//     already-resolved rows (WHERE resolved_talent_id IS NULL); (b)
//     canonicalize's own resolved_talent_id short-circuit (T2-2a Step 2)
//     catches any race-induced re-fire (e.g. two ticks racing on the
//     same row both serialize on the SELECT FOR UPDATE lock; only the
//     first does work, the second short-circuits).
//
//   - Atomicity: createPayload's commit IS the trigger commit. The
//     RawPayloadReference row appearing in the ingestion schema IS the
//     "trigger fired" signal — no separate outbox-event write needed.
//
//   - No cycle: canonicalization already imports ingestion (T2-2a
//     follower direction). The trigger processor lives IN
//     libs/canonicalization; no reverse ingestion → canonicalization
//     edge is introduced. lint:nx-boundaries stays green.
//
// Boundary re-frame (T2-3): resolution now lives IN Core canonicalization
// (the A5b-2 deferral vindicated; T2-1 ruled it belongs here). The ATS
// adapter STILL has no resolver — the ATS no-resolution tripwire
// (apps/api/src/tests/ats-batch4b-talent-link.integration.spec.ts) holds.
//
// Lifecycle mirrors OutboxPublisherProcessor / MatchingProcessor (ADR-0018
// Decision 1): manualRegistration + onApplicationBootstrap gate on
// RedisConnectionConfig.isConfigured. Boot is silent when Redis is
// unconfigured; the worker registers only when REDIS_URL is present.

export interface CanonicalizationTriggerTickInput {
  // Reserved for future per-batch-size overrides. Empty at T2-3.
  override_batch_size?: number;
}

interface DrainResult {
  attempted: number;
  succeeded: number;
  failed: number;
}

@Processor(CANONICALIZATION_TRIGGER_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class CanonicalizationTriggerProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly service: CanonicalizationService,
    private readonly repo: CanonicalizationRepository,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('CanonicalizationTriggerProcessorLogger')
    private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(job: Job<CanonicalizationTriggerTickInput>): Promise<void> {
    const batchSize =
      job.data.override_batch_size ?? CANONICALIZATION_TRIGGER_BATCH_SIZE;

    const result = await this.drainBatch({ batchSize, jobId: job.id ?? null });

    this.logger.log({
      event: 'canonicalization_trigger_tick_completed',
      job_id: job.id ?? null,
      batch_size: batchSize,
      attempted: result.attempted,
      succeeded: result.succeeded,
      failed: result.failed,
    });
  }

  // Exposed for the integration spec — exercises the drain seam end-to-
  // end without standing up a real BullMQ worker. (The test enqueue path
  // is M3 PR-3's precedent — a service-level helper that mirrors what
  // the worker would call.)
  async drainBatch(args: {
    batchSize: number;
    jobId: string | null;
  }): Promise<DrainResult> {
    const unresolved = await this.repo.findUnresolvedPayloadBatch({
      limit: args.batchSize,
    });

    if (unresolved.length === 0) {
      this.logger.debug({
        event: 'canonicalization_trigger_tick_empty',
        job_id: args.jobId,
      });
      return { attempted: 0, succeeded: 0, failed: 0 };
    }

    let succeeded = 0;
    let failed = 0;

    // Per-payload isolation — a failure on one payload does NOT abort
    // the rest of the batch. The failed payload remains resolved_talent_
    // id NULL, so the next tick re-picks it (durability).
    for (const row of unresolved) {
      try {
        const result = await this.service.canonicalize({
          payload_id: row.id,
          // T2-3 production path: core_talent_id + resolution_method
          // OMITTED → the inline resolver runs.
          source_channel: this.mapSourceToChannel(row.source),
          authContext: { tenant_id: row.tenant_id },
          requestId: `canon-trigger:${args.jobId ?? 'manual'}:${row.id}`,
        });
        succeeded += 1;
        this.logger.log({
          event: 'canonicalization_trigger_payload_canonicalized',
          job_id: args.jobId,
          payload_id: row.id,
          tenant_id: row.tenant_id,
          subject_id: result.subject_id,
          resolution_method: result.resolution_method,
          already_canonicalized: result.already_canonicalized,
        });
      } catch (err) {
        failed += 1;
        // Per-payload errors are surfaced via structured log; the row
        // stays unresolved → next tick re-picks. Out-of-tenant payloads
        // (CANONICALIZATION_PAYLOAD_NOT_FOUND) are unreachable here since
        // we always call with the row's own tenant_id, but the AramoError
        // shape is logged faithfully for forensics.
        this.logger.warn({
          event: 'canonicalization_trigger_payload_failed',
          job_id: args.jobId,
          payload_id: row.id,
          tenant_id: row.tenant_id,
          error_code:
            err instanceof AramoError ? err.code : 'UNKNOWN',
          error_message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { attempted: unresolved.length, succeeded, failed };
  }

  // Map ingestion source → TalentTenantOverlay.source_channel closed
  // vocabulary (Talent Record Spec §2.2): self_signup | recruiter_capture
  // | referral | import. Conservative default = 'import' (the recruiter-
  // pushed shortlist case + indeed + astre_import all land here); the
  // self_signup mapping is reserved for the talent_direct source the
  // payload-ingest endpoint marks.
  private mapSourceToChannel(source: string): string {
    if (source === 'talent_direct') return 'self_signup';
    return 'import';
  }

  onApplicationBootstrap(): void {
    if (!this.redisConfig.isConfigured) {
      this.logger.warn({
        event: 'canonicalization_trigger_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
