import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import {
  CommonModule,
  createAramoLogger,
  RedisConnectionConfig,
} from '@aramo/common';
import { TalentTrustModule } from '@aramo/talent-trust';
import { TalentRecordModule } from '@aramo/talent-record';
import { IdentityIndexModule } from '@aramo/identity-index';
import { PlatformTrustModule } from '@aramo/platform-trust';
import { PortalIdentityModule } from '@aramo/portal-identity';
import { MailerModule } from '@aramo/mailer';

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
import { IdentityLifecycleSweepService } from '../talent-identity/identity-lifecycle-sweep.service.js';
import { DormantNoticeService } from '../talent-identity/dormant-notice.service.js';
import { IdentityLifecycleSweepProcessor } from '../talent-identity/identity-lifecycle-sweep.processor.js';
import { IDENTITY_INDEX_LIFECYCLE_QUEUE_NAME } from '../talent-identity/identity-lifecycle-sweep.queue.constants.js';

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
    // TR-2b B2a — the identity-index lifecycle sweep needs the cluster index
    // (IdentityIndexRepository + ClusterPurgeService) and the DormantLink store
    // (PlatformTrustRepository). apps/api is untagged, so these imports open no
    // nx boundary edge (the wall governs the tagged libs).
    IdentityIndexModule,
    PlatformTrustModule,
    // Portal P4a — the dormant-notice delivery orchestration needs the portal
    // identity store (PortalIdentityRepository, the D-4 portal-rail join +
    // NoticeDelivery record) and the standing mail port (MAILER_PORT).
    PortalIdentityModule,
    MailerModule,
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
    // TR-2b B2a — the daily identity-index lifecycle sweep (same wiring).
    BullModule.registerQueue({ name: IDENTITY_INDEX_LIFECYCLE_QUEUE_NAME }),
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
    IdentityLifecycleSweepService,
    IdentityLifecycleSweepProcessor,
    DormantNoticeService,
    {
      provide: 'DormantNoticeServiceLogger',
      useFactory: () => createAramoLogger(DormantNoticeService.name),
    },
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
    {
      provide: 'IdentityLifecycleSweepServiceLogger',
      useFactory: () => createAramoLogger(IdentityLifecycleSweepService.name),
    },
    {
      provide: 'IdentityLifecycleSweepProcessorLogger',
      useFactory: () => createAramoLogger(IdentityLifecycleSweepProcessor.name),
    },
  ],
  exports: [
    MatchSweepService,
    IdentityDetectionService,
    ConsistencyService,
    RecomputeSweepService,
    IdentityLifecycleSweepService,
  ],
})
export class IdentityMaintenanceModule {}
