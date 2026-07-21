import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';

import { JobDistributionSyncService } from './job-distribution-sync.service.js';
import { JOB_DISTRIBUTION_SYNC_QUEUE_NAME } from './job-distribution-sync.queue.constants.js';

// SRC-2 PR-3 (R4) — the job-distribution freshness-sweep worker. The 5-minute
// SCHEDULES tick (registration.ts) enqueues a job; this worker drains one tick.
// Lifecycle mirrors the match-sweep / reconcile poll processors (ADR-0018
// Decision 1): manualRegistration + onApplicationBootstrap gate on
// RedisConnectionConfig — SILENT when Redis is unconfigured (CI / local dev without
// Redis), registered only when REDIS_URL is present. The drain seam
// (JobDistributionSyncService.tick) is exercised directly by the integration spec
// without a real worker (the precedent).
@Processor(JOB_DISTRIBUTION_SYNC_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class JobDistributionSyncProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly service: JobDistributionSyncService,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('JobDistributionSyncProcessorLogger')
    private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    await this.service.tick();
  }

  onApplicationBootstrap(): void {
    if (!this.redisConfig.isConfigured) {
      this.logger.warn({
        event: 'job_distribution_sync_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
