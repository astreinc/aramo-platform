import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';

import { RecomputeSweepService } from './recompute-sweep.service.js';
import { RECOMPUTE_SWEEP_QUEUE_NAME } from './recompute-sweep.queue.constants.js';

// TR-5 B1 (DDR §2) — the daily decay-recompute sweep worker. The SCHEDULES cron
// enqueues a tick; this worker drains a time-gated batch, recomputing each
// stale ACTIVE subject so decay is charged on the clock's schedule. Lifecycle
// mirrors the TR-4/TR-6 poll processors: manualRegistration +
// onApplicationBootstrap Redis gate (silent when REDIS_URL is absent). The tick
// seam (RecomputeSweepService.tick) is exercised directly by the acceptance
// spec — no real worker needed.
@Processor(RECOMPUTE_SWEEP_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class RecomputeSweepProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly service: RecomputeSweepService,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('RecomputeSweepProcessorLogger')
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
        event: 'recompute_sweep_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
