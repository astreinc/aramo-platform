import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';

import { ResumeTextService } from './resume-text.service.js';
import {
  RESUME_REINDEX_BATCH_SIZE,
  RESUME_REINDEX_QUEUE_NAME,
} from './resume-reindex.queue.constants.js';

// Search PR-2 — the résumé re-extract tick worker. Drains `pending`
// talent_resume_text rows (the polling-outbox signal) via
// ResumeTextService.drainPendingBatch on each BullMQ repeat tick.
//
// Lifecycle mirrors CanonicalizationTriggerProcessor / OutboxPublisherProcessor
// (ADR-0018 Decision 1): manualRegistration + onApplicationBootstrap gate on
// RedisConnectionConfig.isConfigured. Boot is silent when Redis is unconfigured
// (CI, local dev); the worker registers only when REDIS_URL is present. The
// proofs exercise drainPendingBatch directly — no live worker needed.

export interface ResumeReindexTickInput {
  override_batch_size?: number;
}

@Processor(RESUME_REINDEX_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class ResumeReindexProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly service: ResumeTextService,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('ResumeReindexProcessorLogger')
    private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(job: Job<ResumeReindexTickInput>): Promise<void> {
    const limit = job.data.override_batch_size ?? RESUME_REINDEX_BATCH_SIZE;
    const result = await this.service.drainPendingBatch({ limit });
    this.logger.log({
      event: 'resume_reindex_tick_completed',
      job_id: job.id ?? null,
      attempted: result.attempted,
      extracted: result.extracted,
      failed: result.failed,
    });
  }

  onApplicationBootstrap(): void {
    if (!this.redisConfig.isConfigured) {
      this.logger.warn({
        event: 'resume_reindex_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
