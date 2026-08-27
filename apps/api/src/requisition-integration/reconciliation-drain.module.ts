import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CommonModule, createAramoLogger, RedisConnectionConfig } from '@aramo/common';

import { RequisitionIntegrationModule } from './requisition-integration.module.js';
import { ReconciliationDrainProcessor } from './reconciliation-drain.processor.js';
import { RECONCILIATION_DRAIN_QUEUE_NAME } from './reconciliation-drain.queue.constants.js';

// CB-D2-R (ADR-0030) — the reconciliation-drain worker module (apps/api
// composition root). Imports RequisitionIntegrationModule (the drain service).
// BullMQ wiring mirrors LifecyclePollModule verbatim: forRootAsync with
// manualRegistration + lazyConnect + a RedisConnectionConfig factory;
// registerQueue for the one queue with NO repeat (the SCHEDULES registrar
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
    BullModule.registerQueue({ name: RECONCILIATION_DRAIN_QUEUE_NAME }),
  ],
  providers: [
    ReconciliationDrainProcessor,
    {
      provide: 'ReconciliationDrainProcessorLogger',
      useFactory: () => createAramoLogger(ReconciliationDrainProcessor.name),
    },
  ],
})
export class ReconciliationDrainModule {}
