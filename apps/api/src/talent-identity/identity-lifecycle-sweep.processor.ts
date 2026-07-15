import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';

import { IdentityLifecycleSweepService } from './identity-lifecycle-sweep.service.js';
import { IDENTITY_INDEX_LIFECYCLE_QUEUE_NAME } from './identity-lifecycle-sweep.queue.constants.js';

// TR-2b B2a (Directive §PR-1.3) — the daily identity-index lifecycle sweep
// worker. The SCHEDULES cron ('0 5 * * *') enqueues a tick; this worker drains a
// bounded keyset batch (orphan purge LIVE + dormant detection DARK). Lifecycle
// mirrors the TR-5 recompute-sweep / TR-6 poll processors: manualRegistration +
// onApplicationBootstrap Redis gate (silent when REDIS_URL is absent). The tick
// seam (IdentityLifecycleSweepService.tick) is exercised directly by the
// acceptance spec — no real worker needed.
@Processor(IDENTITY_INDEX_LIFECYCLE_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class IdentityLifecycleSweepProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly service: IdentityLifecycleSweepService,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('IdentityLifecycleSweepProcessorLogger')
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
        event: 'identity_lifecycle_sweep_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
