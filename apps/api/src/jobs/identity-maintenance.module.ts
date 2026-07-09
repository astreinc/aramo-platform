import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import {
  CommonModule,
  createAramoLogger,
  RedisConnectionConfig,
} from '@aramo/common';
import { TalentTrustModule } from '@aramo/talent-trust';
import { TalentRecordModule } from '@aramo/talent-record';

import { MatchSweepService } from '../talent-anchor/match-sweep.service.js';
import { MatchSweepProcessor } from '../talent-anchor/match-sweep.processor.js';
import { MATCH_SWEEP_QUEUE_NAME } from '../talent-anchor/match-sweep.queue.constants.js';
import { IdentityDetectionService } from '../talent-identity/identity-detection.service.js';
import { IdentityDetectionProcessor } from '../talent-identity/identity-detection.processor.js';
import { IDENTITY_DETECTION_QUEUE_NAME } from '../talent-identity/identity-detection.queue.constants.js';
import { ConsistencyService } from '../talent-identity/consistency.service.js';
import { ConsistencyProcessor } from '../talent-identity/consistency.processor.js';
import { CONSISTENCY_QUEUE_NAME } from '../talent-identity/consistency.queue.constants.js';
import { RecomputeSweepService } from '../talent-identity/recompute-sweep.service.js';
import { RecomputeSweepProcessor } from '../talent-identity/recompute-sweep.processor.js';
import { RECOMPUTE_SWEEP_QUEUE_NAME } from '../talent-identity/recompute-sweep.queue.constants.js';

// TR-6 B1 (DDR §2/§7) — the identity-maintenance job module: the hourly incremental
// match sweep (D1) + the daily read-only integrity detection cron (D6). apps/api
// boundary layer (the reconcile/orchestrator precedent) — imports {talent-trust
// (cip), talent-record (ats)}; ats→cip is wall-clean and both edges already exist
// (NO new @aramo/* edge). talent_trust imports NO ats.
//
// BullModule wiring mirrors TalentReconcileModule verbatim: forRootAsync with
// manualRegistration + lazyConnect + a RedisConnectionConfig factory; registerQueue
// per named queue; per-processor logger factory tokens. Both workers gate on
// RedisConnectionConfig.isConfigured (silent when REDIS_URL is absent — CI / local
// dev without Redis); the SCHEDULES registrar (registration.ts) enqueues the ticks.
@Module({
  imports: [
    CommonModule,
    TalentTrustModule,
    TalentRecordModule,
    BullModule.forRootAsync({
      extraOptions: { manualRegistration: true },
      useFactory: (cfg: RedisConnectionConfig) => {
        const baseOpts = {
          skipWaitingForReady: true,
          skipVersionCheck: true,
          skipMetasUpdate: true,
        };
        try {
          return {
            ...baseOpts,
            connection: { ...cfg.connection, lazyConnect: true },
          };
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
    BullModule.registerQueue({ name: MATCH_SWEEP_QUEUE_NAME }),
    BullModule.registerQueue({ name: IDENTITY_DETECTION_QUEUE_NAME }),
    // TR-4 B3 — the hourly consistency detector poll (same wiring as the others).
    BullModule.registerQueue({ name: CONSISTENCY_QUEUE_NAME }),
    // TR-5 B1 — the daily decay-recompute sweep (same wiring as the others).
    BullModule.registerQueue({ name: RECOMPUTE_SWEEP_QUEUE_NAME }),
  ],
  providers: [
    MatchSweepService,
    MatchSweepProcessor,
    IdentityDetectionService,
    IdentityDetectionProcessor,
    ConsistencyService,
    ConsistencyProcessor,
    RecomputeSweepService,
    RecomputeSweepProcessor,
    {
      provide: 'MatchSweepServiceLogger',
      useFactory: () => createAramoLogger(MatchSweepService.name),
    },
    {
      provide: 'MatchSweepProcessorLogger',
      useFactory: () => createAramoLogger(MatchSweepProcessor.name),
    },
    {
      provide: 'IdentityDetectionServiceLogger',
      useFactory: () => createAramoLogger(IdentityDetectionService.name),
    },
    {
      provide: 'IdentityDetectionProcessorLogger',
      useFactory: () => createAramoLogger(IdentityDetectionProcessor.name),
    },
    {
      provide: 'ConsistencyServiceLogger',
      useFactory: () => createAramoLogger(ConsistencyService.name),
    },
    {
      provide: 'ConsistencyProcessorLogger',
      useFactory: () => createAramoLogger(ConsistencyProcessor.name),
    },
    {
      provide: 'RecomputeSweepServiceLogger',
      useFactory: () => createAramoLogger(RecomputeSweepService.name),
    },
    {
      provide: 'RecomputeSweepProcessorLogger',
      useFactory: () => createAramoLogger(RecomputeSweepProcessor.name),
    },
  ],
  exports: [MatchSweepService, IdentityDetectionService, ConsistencyService, RecomputeSweepService],
})
export class IdentityMaintenanceModule {}
