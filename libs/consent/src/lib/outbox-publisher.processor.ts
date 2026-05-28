import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';

import { OutboxPublisherRepository } from './outbox-publisher.repository.js';
import {
  OUTBOX_PUBLISHER_BATCH_SIZE,
  OUTBOX_PUBLISHER_QUEUE_NAME,
} from './outbox-publisher.queue.constants.js';

// M5 PR-11 §4.3 — outbox-publisher BullMQ processor.
//
// Architecture v2.1 §9.2 / Plan v1.5 §M5 Track A item 6 binding. Polls
// libs/consent.OutboxEvent for unpublished rows, emits them downstream
// (logged at PR-11; SNS dispatch is M6/M7 binding per ADR-0018 Decision 4),
// and marks each row published_at = now().
//
// LIGHT-SCOPE per audit Axis B Lead-Q-B1=(a). Multi-schema outbox expansion
// (engagement + submittal + examination outboxes) is deferred to M6.
//
// Lifecycle mirrors libs/matching/src/lib/matching.processor.ts pattern
// (ADR-0018 Decision 1): manualRegistration + onApplicationBootstrap gate
// on RedisConnectionConfig.isConfigured + BullRegistrar.register() on
// configured path.

export interface OutboxPublisherTickInput {
  // Reserved for future per-tenant or batch-size overrides. Empty at PR-11.
  override_batch_size?: number;
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
    private readonly outboxRepo: OutboxPublisherRepository,
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

    const unpublished = await this.outboxRepo.findUnpublishedEvents({
      limit: batchSize,
    });

    if (unpublished.length === 0) {
      this.logger.debug({
        event: 'outbox_publisher_tick_empty',
        job_id: job.id ?? null,
      });
      return;
    }

    // PR-11 emits via structured log only; SNS dispatch is M6/M7 binding
    // per ADR-0018 Decision 4. Each event is logged for downstream
    // observability + manual replay forensics.
    for (const ev of unpublished) {
      this.logger.log({
        event: 'outbox_event_published',
        outbox_event_id: ev.id,
        tenant_id: ev.tenant_id,
        event_type: ev.event_type,
        outbox_created_at: ev.created_at.toISOString(),
      });
    }

    const publishedAt = new Date();
    const count = await this.outboxRepo.markPublished({
      event_ids: unpublished.map((ev) => ev.id),
      published_at: publishedAt,
    });

    this.logger.log({
      event: 'outbox_publisher_tick_completed',
      job_id: job.id ?? null,
      batch_size: batchSize,
      published_count: count,
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
