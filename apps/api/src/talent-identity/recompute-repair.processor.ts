import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';

import { RecomputeRepairService } from './recompute-repair.service.js';
import { RECOMPUTE_REPAIR_QUEUE_NAME } from './recompute-repair.queue.constants.js';

// G1 (Aramo-G1-TrustState-Recompute-Ordering-and-Recovery-Directive-v1_0-LOCKED
// §3.3) — the TrustState recomputation-repair worker. The SCHEDULES entry
// (jobs/registration.ts) enqueues a tick every RECOMPUTE_REPAIR_INTERVAL_MS; this
// worker drains a bounded batch of pending requests. Lifecycle mirrors the
// recompute-sweep processor: manualRegistration + onApplicationBootstrap Redis
// gate (silent when REDIS_URL is absent).
@Processor(RECOMPUTE_REPAIR_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class RecomputeRepairProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly service: RecomputeRepairService,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('RecomputeRepairProcessorLogger')
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
        event: 'recompute_repair_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
