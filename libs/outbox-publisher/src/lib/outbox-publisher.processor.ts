import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';
import { OutboxPublisherRepository } from '@aramo/consent';
import { EngagementOutboxRepository } from '@aramo/engagement';
import { SubmittalOutboxRepository } from '@aramo/submittal';

import {
  OUTBOX_PUBLISHER_BATCH_SIZE,
  OUTBOX_PUBLISHER_QUEUE_NAME,
} from './outbox-publisher.queue.constants.js';

// M6 PR-2 §4 — multi-schema outbox publisher (relocated + extended).
//
// Relocated from libs/consent (M5 PR-11 placement) to the new leaf lib
// libs/outbox-publisher per M6 PR-2 §4 / Amendment §2.4. The relocation
// avoids the consent → engagement|submittal cycle that would have
// resulted from injecting engagement + submittal repositories into a
// processor living in libs/consent (lint-nx-boundaries / import-x/
// no-cycle enforcement).
//
// Architecture v2.1 §9.2 / Plan v1.5 §M5 Track A item 6 binding (extended
// to the M6 PR-2 multi-schema scope: consent + engagement + submittal).
// Polls each schema's OutboxEvent table for unpublished rows, emits them
// downstream (logged at this PR; SNS dispatch lands at PR-3), and marks
// each row published_at = now(). Examination is OUT OF SCOPE (deferred
// to PR-2d — no transaction boundary on examination mutations today).
//
// Per-schema drain semantics:
//   - Each repository's findUnpublishedEvents returns up to
//     OUTBOX_PUBLISHER_BATCH_SIZE rows, oldest first.
//   - markPublished bulk-stamps published_at on the drained rows.
//   - Failures in one schema's drain do NOT abort the other schemas;
//     each drain is wrapped so the tick attempts all three.
//
// Lifecycle mirrors libs/matching/src/lib/matching.processor.ts pattern
// (ADR-0018 Decision 1): manualRegistration + onApplicationBootstrap gate
// on RedisConnectionConfig.isConfigured + BullRegistrar.register() on
// configured path. Consent's emission behavior (libs/consent
// ConsentRepository) is UNCHANGED — only the drain side relocates.

export interface OutboxPublisherTickInput {
  // Reserved for future per-tenant or batch-size overrides. Empty at
  // M5 PR-11 / M6 PR-2.
  override_batch_size?: number;
}

interface OutboxRepositoryShape {
  findUnpublishedEvents(input: { limit: number }): Promise<
    ReadonlyArray<{
      id: string;
      tenant_id: string;
      event_type: string;
      event_payload: unknown;
      created_at: Date;
    }>
  >;
  markPublished(input: {
    event_ids: readonly string[];
    published_at: Date;
  }): Promise<number>;
}

@Processor(OUTBOX_PUBLISHER_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class OutboxPublisherProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly consentOutbox: OutboxPublisherRepository,
    private readonly engagementOutbox: EngagementOutboxRepository,
    private readonly submittalOutbox: SubmittalOutboxRepository,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('OutboxPublisherProcessorLogger')
    private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(job: Job<OutboxPublisherTickInput>): Promise<void> {
    const batchSize =
      job.data.override_batch_size ?? OUTBOX_PUBLISHER_BATCH_SIZE;

    const consentCount = await this.drainSchema(
      'consent',
      this.consentOutbox,
      batchSize,
      job,
    );
    const engagementCount = await this.drainSchema(
      'engagement',
      this.engagementOutbox,
      batchSize,
      job,
    );
    const submittalCount = await this.drainSchema(
      'submittal',
      this.submittalOutbox,
      batchSize,
      job,
    );

    this.logger.log({
      event: 'outbox_publisher_tick_completed',
      job_id: job.id ?? null,
      batch_size: batchSize,
      consent_published_count: consentCount,
      engagement_published_count: engagementCount,
      submittal_published_count: submittalCount,
      total_published_count: consentCount + engagementCount + submittalCount,
    });
  }

  private async drainSchema(
    schemaName: 'consent' | 'engagement' | 'submittal',
    repo: OutboxRepositoryShape,
    batchSize: number,
    job: Job<OutboxPublisherTickInput>,
  ): Promise<number> {
    const unpublished = await repo.findUnpublishedEvents({ limit: batchSize });

    if (unpublished.length === 0) {
      this.logger.debug({
        event: 'outbox_publisher_schema_tick_empty',
        schema: schemaName,
        job_id: job.id ?? null,
      });
      return 0;
    }

    // M5 PR-11 + M6 PR-2 emit via structured log only; SNS dispatch is
    // M7 binding per ADR-0018 Decision 4. Each event is logged for
    // downstream observability + manual replay forensics.
    for (const ev of unpublished) {
      this.logger.log({
        event: 'outbox_event_published',
        schema: schemaName,
        outbox_event_id: ev.id,
        tenant_id: ev.tenant_id,
        event_type: ev.event_type,
        outbox_created_at: ev.created_at.toISOString(),
      });
    }

    const publishedAt = new Date();
    return repo.markPublished({
      event_ids: unpublished.map((ev) => ev.id),
      published_at: publishedAt,
    });
  }

  onApplicationBootstrap(): void {
    if (!this.redisConfig.isConfigured) {
      this.logger.warn({
        event: 'outbox_publisher_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
