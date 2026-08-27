import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CommonModule, createAramoLogger, RedisConnectionConfig } from '@aramo/common';

import { RequisitionIntegrationModule } from './requisition-integration.module.js';
import { LifecyclePollProcessor } from './lifecycle-poll.processor.js';
import { LIFECYCLE_POLL_QUEUE_NAME } from './lifecycle-poll.queue.constants.js';

// CB-D2-A1 (ADR-0030, R-PRODUCER) — the lifecycle-poll worker module (apps/api
// composition root). Imports RequisitionIntegrationModule (the LifecyclePollProducer
// + ingress seam). BullMQ wiring mirrors JobDistributionSyncModule verbatim:
// forRootAsync with manualRegistration + lazyConnect + a RedisConnectionConfig
// factory; registerQueue for the one queue with NO repeat (the SCHEDULES registrar
// enqueues the repeat tick). The worker gates on RedisConnectionConfig.isConfigured
// (silent when REDIS_URL is absent — CI / local dev without Redis).
@Module({
  imports: [
    CommonModule,
    RequisitionIntegrationModule,
    BullModule.forRootAsync({
      extraOptions: { manualRegistration: true },
      useFactory: (cfg: RedisConnectionConfig) => {
        const baseOpts = {
          skipWaitingForReady: true,
          skipVersionCheck: true,
          skipMetasUpdate: true,
        };
        try {
          return { ...baseOpts, connection: { ...cfg.connection, lazyConnect: true } };
        } catch (err) {
          if (err instanceof Error && err.message === 'REDIS_URL is not configured') {
            return {
              ...baseOpts,
              connection: { host: '127.0.0.1', port: 6379, lazyConnect: true },
            };
          }
          throw err;
        }
      },
      inject: [RedisConnectionConfig],
      extraProviders: [RedisConnectionConfig],
    }),
    BullModule.registerQueue({ name: LIFECYCLE_POLL_QUEUE_NAME }),
  ],
  providers: [
    LifecyclePollProcessor,
    {
      provide: 'LifecyclePollProcessorLogger',
      useFactory: () => createAramoLogger(LifecyclePollProcessor.name),
    },
  ],
})
export class LifecyclePollModule {}
