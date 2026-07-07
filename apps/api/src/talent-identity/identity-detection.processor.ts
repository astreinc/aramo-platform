import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';

import { IdentityDetectionService } from './identity-detection.service.js';
import { IDENTITY_DETECTION_QUEUE_NAME } from './identity-detection.queue.constants.js';

// TR-6 B1 (DDR §7) — the daily integrity-detection worker. The SCHEDULES cron
// enqueues a job; this worker runs every detector once (READ-ONLY) and logs the
// per-class report. Lifecycle mirrors the other poll processors: manualRegistration
// + onApplicationBootstrap Redis gate (silent when REDIS_URL is absent). The detect
// seam (IdentityDetectionService.runDetection) is exercised directly by the
// acceptance spec — no real worker, and the spec asserts zero writes.
@Processor(IDENTITY_DETECTION_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class IdentityDetectionProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly service: IdentityDetectionService,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('IdentityDetectionProcessorLogger')
    private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    await this.service.runDetection();
  }

  onApplicationBootstrap(): void {
    if (!this.redisConfig.isConfigured) {
      this.logger.warn({
        event: 'identity_detection_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
