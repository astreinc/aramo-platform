import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';

import { LifecyclePollProducer } from './lifecycle-poll.producer.js';
import { LIFECYCLE_POLL_QUEUE_NAME } from './lifecycle-poll.queue.constants.js';

// CB-D2-A1 (ADR-0030, R-PRODUCER) — the lifecycle-poll worker. The SCHEDULES tick
// (registration.ts) enqueues a job; this worker sweeps every ACTIVE lifecycle-
// capable connection (fetch → raw-persist → ingress → cursor-advance). Lifecycle
// mirrors the connector-execution / job-distribution processors (ADR-0018
// Decision 1): manualRegistration + onApplicationBootstrap gate on
// RedisConnectionConfig — SILENT when Redis is unconfigured (CI / local dev without
// Redis). The producer seam (LifecyclePollProducer.pollConnection) is exercised
// directly by the integration proofs with a fake lifecycle source (no Redis).
@Processor(LIFECYCLE_POLL_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class LifecyclePollProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly producer: LifecyclePollProducer,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('LifecyclePollProcessorLogger')
    private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    await this.producer.pollAllActive();
  }

  onApplicationBootstrap(): void {
    if (!this.redisConfig.isConfigured) {
      this.logger.warn({
        event: 'lifecycle_poll_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
