import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';

import { OfferExpiryProducer } from './offer-expiry.producer.js';
import { OFFER_EXPIRY_QUEUE_NAME } from './offer-expiry.queue.constants.js';

// L4 / P6 — the offer auto-expiry worker. The SCHEDULES tick (jobs/registration.ts)
// enqueues a repeat job; this worker sweeps overdue offers to EXPIRED. Lifecycle
// mirrors the lifecycle-poll / job-distribution processors (ADR-0018 Decision 1):
// manualRegistration + onApplicationBootstrap gate on RedisConnectionConfig — SILENT
// when Redis is unconfigured (CI / local dev without Redis). The producer seam
// (OfferExpiryProducer.sweep) is exercised directly by the integration proof.
@Processor(OFFER_EXPIRY_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class OfferExpiryProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly producer: OfferExpiryProducer,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('OfferExpiryProcessorLogger')
    private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    await this.producer.sweep();
  }

  onApplicationBootstrap(): void {
    if (!this.redisConfig.isConfigured) {
      this.logger.warn({
        event: 'offer_expiry_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
