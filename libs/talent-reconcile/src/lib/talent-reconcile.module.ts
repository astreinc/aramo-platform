import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import {
  CommonModule,
  createAramoLogger,
  RedisConnectionConfig,
} from '@aramo/common';
import { TalentRecordModule } from '@aramo/talent-record';
import { TalentTrustModule } from '@aramo/talent-trust';

import { TalentReconcileService } from './talent-reconcile.service.js';
import { TalentReconcileProcessor } from './talent-reconcile.processor.js';
import { TALENT_RECONCILE_QUEUE_NAME } from './talent-reconcile.queue.constants.js';

// Promotion Gate Slice-B1 — the reconcile poll module (scope:ats).
//
//   - Above the I15 wall: imports TalentTrustModule (cip — read evidence,
//     find/mark/bump the watermark) + TalentRecordModule (ats — findById +
//     the reconcile writes). ats→cip is wall-allowed (the canonicalization
//     precedent); cip imports NO ats. NO controller (a background poll).
//
//   - The TalentReconcileProcessor is a BullMQ tick worker draining promoted
//     subjects with newer evidence. BullModule wiring mirrors
//     CanonicalizationModule / ColdIngestExtractionModule verbatim: forRootAsync
//     with manualRegistration + lazyConnect + RedisConnectionConfig factory;
//     registerQueue for the named queue; per-processor logger factory token.
//
//   - Deliberately NOT imported: @aramo/ai-draft / any LLM — the reconcile
//     projection is deterministic (ADR-0015 Decision 10).
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
    BullModule.registerQueue({ name: TALENT_RECONCILE_QUEUE_NAME }),
  ],
  providers: [
    TalentReconcileService,
    TalentReconcileProcessor,
    {
      provide: 'TalentReconcileServiceLogger',
      useFactory: () => createAramoLogger(TalentReconcileService.name),
    },
    {
      provide: 'TalentReconcileProcessorLogger',
      useFactory: () => createAramoLogger(TalentReconcileProcessor.name),
    },
  ],
  exports: [TalentReconcileService, TalentReconcileProcessor],
})
export class TalentReconcileModule {}
