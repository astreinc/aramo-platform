import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CommonModule, createAramoLogger, RedisConnectionConfig } from '@aramo/common';

import { TalentReconcileProducer } from './talent-reconcile-signal.producer.js';
import { TALENT_RECONCILE_QUEUE_NAME } from './talent-reconcile-signal.queue.constants.js';

// TALENT-INTEL-1 TI-1F-C — the Talent-profile reconcile PRODUCER module (mirrors
// CanonicalReconcileModule). Registers the talent-reconcile queue + the
// best-effort producer. Imported by talent-record (push signal on CONFIRM /
// confirmed CREATE) and by libs/talent-reconcile (the worker self-schedules the
// backstop tick). It imports NO reconcile worker (leaf: only @aramo/common) so
// there is no nx cycle — the worker/@Processor that CONSUMES this queue lives in
// libs/talent-reconcile.
//
// BullModule.forRootAsync mirrors the canonical-reconcile pattern
// (manualRegistration; Redis-tolerant factory so module init completes without
// REDIS_URL — the producer is separately Redis-gated).
@Module({
  imports: [
    CommonModule,
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
            return { ...baseOpts, connection: { host: '127.0.0.1', port: 6379, lazyConnect: true } };
          }
          throw err;
        }
      },
      inject: [RedisConnectionConfig],
      extraProviders: [RedisConnectionConfig],
    }),
    BullModule.registerQueue({ name: TALENT_RECONCILE_QUEUE_NAME }),
  ],
  providers: [
    TalentReconcileProducer,
    {
      provide: 'TalentReconcileProducerLogger',
      useFactory: () => createAramoLogger(TalentReconcileProducer.name),
    },
  ],
  exports: [TalentReconcileProducer],
})
export class TalentReconcileSignalModule {}
