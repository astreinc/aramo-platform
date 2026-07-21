import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import {
  CommonModule,
  createAramoLogger,
  RedisConnectionConfig,
} from '@aramo/common';
import { JobDistributionModule } from '@aramo/job-distribution';
import { RequisitionModule } from '@aramo/requisition';

import { JobDistributionSyncService } from './job-distribution-sync.service.js';
import { JobDistributionSyncProcessor } from './job-distribution-sync.processor.js';
import { JOB_DISTRIBUTION_SYNC_QUEUE_NAME } from './job-distribution-sync.queue.constants.js';

// SRC-2 PR-3 (R4) — the job-distribution sweep module (apps/api composition root,
// PRIMARY ruling). Imports RequisitionModule (RequisitionRepository — the
// publishable read) + JobDistributionModule (the lib primitives: posting-state
// repo, connector, token service). apps/api is untagged, so these imports open no
// nx boundary edge, and the lib itself carries none. BullMQ wiring mirrors
// IdentityMaintenanceModule verbatim: forRootAsync with manualRegistration +
// lazyConnect + a RedisConnectionConfig factory; registerQueue for the one queue;
// per-provider logger factory tokens. The worker gates on
// RedisConnectionConfig.isConfigured (silent when REDIS_URL is absent — CI / local
// dev without Redis); the SCHEDULES registrar (registration.ts) enqueues the tick.
@Module({
  imports: [
    CommonModule,
    RequisitionModule,
    JobDistributionModule,
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
    BullModule.registerQueue({ name: JOB_DISTRIBUTION_SYNC_QUEUE_NAME }),
  ],
  providers: [
    JobDistributionSyncService,
    JobDistributionSyncProcessor,
    {
      provide: 'JobDistributionSyncServiceLogger',
      useFactory: () => createAramoLogger(JobDistributionSyncService.name),
    },
    {
      provide: 'JobDistributionSyncProcessorLogger',
      useFactory: () => createAramoLogger(JobDistributionSyncProcessor.name),
    },
  ],
  exports: [JobDistributionSyncService],
})
export class JobDistributionSyncModule {}
