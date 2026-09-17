import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CommonModule, createAramoLogger, RedisConnectionConfig } from '@aramo/common';

import { CanonicalReconcileProducer } from './canonical-reconcile.producer.js';
import { CANONICAL_RECONCILE_QUEUE_NAME } from './canonical-reconcile.queue.constants.js';

// SKILL-TAX Canonical Reconciliation Activation — the producer module. Registers
// the dedicated canonical-reconciliation queue + the best-effort producer.
// Imported by the two triggering libs (talent-record CREATE, requisition
// confirmProfile) — both scope:ats, legally importing this scope:cip lib. It
// imports NO reconcile worker (no talent-evidence/requisition edge) so no nx
// cycle: the PROCESSOR that consumes this queue lives in apps/api.
//
// BullModule.forRootAsync mirrors the ci-processing / skills-taxonomy pattern
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
    BullModule.registerQueue({ name: CANONICAL_RECONCILE_QUEUE_NAME }),
  ],
  providers: [
    CanonicalReconcileProducer,
    {
      provide: 'CanonicalReconcileProducerLogger',
      useFactory: () => createAramoLogger(CanonicalReconcileProducer.name),
    },
  ],
  exports: [CanonicalReconcileProducer],
})
export class CanonicalReconcileModule {}
