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
import { ContradictionDetectionService } from './contradiction-detection.service.js';
import { ContradictionDetectionProcessor } from './contradiction-detection.processor.js';
import { CONTRADICTION_DETECTION_QUEUE_NAME } from './contradiction-detection.queue.constants.js';

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
    // Slice-B2 — the contradiction-detection poll's queue (sibling worker).
    BullModule.registerQueue({ name: CONTRADICTION_DETECTION_QUEUE_NAME }),
  ],
  providers: [
    TalentReconcileService,
    TalentReconcileProcessor,
    // Slice-B2 — the contradiction-detection consumer (drains B1's pending store
    // → contradict() → resolved). Deps {talent-record, talent-trust} already
    // imported above.
    ContradictionDetectionService,
    ContradictionDetectionProcessor,
    {
      provide: 'TalentReconcileServiceLogger',
      useFactory: () => createAramoLogger(TalentReconcileService.name),
    },
    {
      provide: 'TalentReconcileProcessorLogger',
      useFactory: () => createAramoLogger(TalentReconcileProcessor.name),
    },
    {
      provide: 'ContradictionDetectionServiceLogger',
      useFactory: () => createAramoLogger(ContradictionDetectionService.name),
    },
    {
      provide: 'ContradictionDetectionProcessorLogger',
      useFactory: () => createAramoLogger(ContradictionDetectionProcessor.name),
    },
  ],
  exports: [
    TalentReconcileService,
    TalentReconcileProcessor,
    ContradictionDetectionService,
    ContradictionDetectionProcessor,
  ],
})
export class TalentReconcileModule {}
