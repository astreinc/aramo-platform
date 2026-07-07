import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';

import { MatchSweepService } from './match-sweep.service.js';
import { MATCH_SWEEP_QUEUE_NAME } from './match-sweep.queue.constants.js';

// TR-6 B1 (DDR §2) — the scheduled incremental match-sweep worker. The hourly
// SCHEDULES tick (registration.ts) enqueues a job; this worker drains one batch.
//
// Lifecycle mirrors the reconcile/extraction/canonicalize poll processors
// (ADR-0018 Decision 1): manualRegistration + onApplicationBootstrap gate on
// RedisConnectionConfig — SILENT when Redis is unconfigured (CI / local dev without
// Redis), registered only when REDIS_URL is present. The drain seam
// (MatchSweepService.tick) is exercised directly by the acceptance spec without a
// real worker (the precedent).
@Processor(MATCH_SWEEP_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class MatchSweepProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly service: MatchSweepService,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('MatchSweepProcessorLogger')
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
        event: 'match_sweep_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
