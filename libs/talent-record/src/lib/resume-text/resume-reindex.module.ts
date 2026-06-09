import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import {
  CommonModule,
  createAramoLogger,
  RedisConnectionConfig,
} from '@aramo/common';

import { TalentRecordModule } from '../talent-record.module.js';

import { ResumeReindexProcessor } from './resume-reindex.processor.js';
import { RESUME_REINDEX_QUEUE_NAME } from './resume-reindex.queue.constants.js';

// Search PR-2 — the résumé re-extract worker module.
//
// Deliberately SEPARATE from TalentRecordModule (which is imported widely —
// by AttachmentModule + apps/api). Isolating the BullMQ wiring here keeps the
// worker out of every TalentRecordModule importer: only apps/api imports this
// module, so only apps/api stands up the résumé-reindex worker. AttachmentModule
// imports TalentRecordModule (for ResumeTextService.enqueueReindex) WITHOUT
// pulling in the worker.
//
// BullModule wiring mirrors CanonicalizationModule verbatim: forRootAsync with
// manualRegistration + lazyConnect + RedisConnectionConfig factory;
// registerQueue for the named queue; a per-processor logger factory token.
@Module({
  imports: [
    CommonModule,
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
          if (
            err instanceof Error &&
            err.message === 'REDIS_URL is not configured'
          ) {
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
    BullModule.registerQueue({ name: RESUME_REINDEX_QUEUE_NAME }),
  ],
  providers: [
    ResumeReindexProcessor,
    {
      provide: 'ResumeReindexProcessorLogger',
      useFactory: () => createAramoLogger(ResumeReindexProcessor.name),
    },
  ],
  exports: [ResumeReindexProcessor],
})
export class ResumeReindexModule {}
