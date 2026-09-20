import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import {
  CommonModule,
  createAramoLogger,
  RedisConnectionConfig,
} from '@aramo/common';
import { TalentExtractionModule } from '@aramo/talent-extraction';

import { TalentRecordModule } from '../talent-record.module.js';

import { ResumeExtractionDraftProcessor } from './resume-extraction-draft.processor.js';
import { RESUME_EXTRACTION_DRAFT_QUEUE_NAME } from './resume-extraction-draft.queue.constants.js';

// TALENT-INTEL-1 (TI-1F-A) — the résumé-extraction-draft worker module.
//
// Deliberately SEPARATE from TalentRecordModule (which is imported widely): only
// apps/api imports this module, so only apps/api stands up the draft worker. It
// imports TalentRecordModule (for the wired ResumeExtractionOrchestrator, now
// exported) + TalentExtractionModule (for the ResumeExtractionDraft repo
// passthroughs on TalentExtractionService).
//
// BullMQ wiring mirrors ResumeReindexModule / CanonicalizationModule verbatim:
// forRootAsync with manualRegistration + lazyConnect + RedisConnectionConfig
// factory; registerQueue for the named queue; a per-processor logger token.
@Module({
  imports: [
    CommonModule,
    TalentRecordModule,
    TalentExtractionModule,
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
    BullModule.registerQueue({ name: RESUME_EXTRACTION_DRAFT_QUEUE_NAME }),
  ],
  providers: [
    ResumeExtractionDraftProcessor,
    {
      provide: 'ResumeExtractionDraftProcessorLogger',
      useFactory: () => createAramoLogger(ResumeExtractionDraftProcessor.name),
    },
  ],
  exports: [ResumeExtractionDraftProcessor],
})
export class ResumeExtractionDraftWorkerModule {}
