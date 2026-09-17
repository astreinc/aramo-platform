import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CommonModule, createAramoLogger, RedisConnectionConfig } from '@aramo/common';
import { TalentSkillCanonicalizationModule } from '@aramo/talent-evidence';
import { RequisitionSkillCanonicalizationModule } from '@aramo/requisition';
import { CanonicalReconcileModule } from '@aramo/canonical-reconcile';

import { CanonicalReconcileConfig } from './canonical-reconcile.config.js';
import { CanonicalReconcileBackstop } from './canonical-reconcile.backstop.js';
import { CanonicalReconcileCoverageService } from './canonical-reconcile-coverage.service.js';
import { CanonicalReconcileProcessor } from './canonical-reconcile.processor.js';

// SKILL-TAX Canonical Reconciliation Activation — apps/api orchestration module.
// Consumes the dedicated canonical-reconciliation queue (producer from
// @aramo/canonical-reconcile) and dispatches to the 1G/1D reconcile workers
// (imported worker modules). Hosts the Talent backstop + coverage telemetry.
// This is the ONLY module that legally imports both scope:cip (talent-evidence)
// and scope:ats (requisition) reconcile workers.
//
// Own forRootAsync(manualRegistration) provides BullRegistrar for the processor
// (mirrors the platform processor pattern; multiple forRootAsync resolve the same
// RedisConnectionConfig source). No new HTTP surface / scope / matching change.
@Module({
  imports: [
    CommonModule,
    CanonicalReconcileModule,
    TalentSkillCanonicalizationModule,
    RequisitionSkillCanonicalizationModule,
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
  ],
  providers: [
    CanonicalReconcileConfig,
    CanonicalReconcileBackstop,
    CanonicalReconcileCoverageService,
    CanonicalReconcileProcessor,
    {
      provide: 'CanonicalReconcileProcessorLogger',
      useFactory: () => createAramoLogger(CanonicalReconcileProcessor.name),
    },
    {
      provide: 'CanonicalReconcileBackstopLogger',
      useFactory: () => createAramoLogger(CanonicalReconcileBackstop.name),
    },
    {
      provide: 'CanonicalReconcileCoverageLogger',
      useFactory: () => createAramoLogger(CanonicalReconcileCoverageService.name),
    },
  ],
  exports: [CanonicalReconcileCoverageService],
})
export class CanonicalReconciliationModule {}
