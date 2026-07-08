import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';

import { ConsistencyService } from './consistency.service.js';
import { CONSISTENCY_QUEUE_NAME } from './consistency.queue.constants.js';

// TR-4 B3 (§3.1) — the hourly consistency detector worker. The SCHEDULES cron
// enqueues a tick; this worker drains a watermark-gated batch, running the three
// deterministic detectors per subject. Lifecycle mirrors the TR-6 poll processors:
// manualRegistration + onApplicationBootstrap Redis gate (silent when REDIS_URL is
// absent). The tick seam (ConsistencyService.tick) is exercised directly by the
// acceptance spec — no real worker needed.
@Processor(CONSISTENCY_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class ConsistencyProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly service: ConsistencyService,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('ConsistencyProcessorLogger')
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
        event: 'consistency_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
