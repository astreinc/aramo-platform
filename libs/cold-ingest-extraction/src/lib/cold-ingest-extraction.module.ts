import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import {
  CommonModule,
  createAramoLogger,
  RedisConnectionConfig,
} from '@aramo/common';

import { ColdIngestExtractionProcessor } from './cold-ingest-extraction.processor.js';
import { COLD_INGEST_EXTRACTION_QUEUE_NAME } from './cold-ingest-extraction.queue.constants.js';

// Cold-Ingest Extraction — the poll module.
//
//   - Consumer-direction leaf. Imports (scope:cip — I15 CIP⊥ATS wall clean, no
//     ats edge):
//       IngestionModule → IngestionRepository (the STAGED arrival poll — the
//                         extract-once markers are preserved for TI-1F-A).
//
//   - TI-1F P0.2 — heuristic résumé FACT extraction is RETIRED (governed LLM is
//     the sole production résumé fact extractor). The service no longer parses
//     résumés or writes declared evidence, so ResumeParseModule + TalentTrustModule
//     are no longer imported. Arrivals are left STAGED for the governed extractor
//     (TI-1F-A), which will re-introduce the appropriate edges.
//
//   - NO controller (a background poll; the canonicalization-trigger precedent).
//
//   - The ColdIngestExtractionProcessor is a BullMQ tick worker (the STAGED-arrival
//     handoff seam). BullModule wiring mirrors CanonicalizationModule verbatim:
//     forRootAsync with manualRegistration + lazyConnect + RedisConnectionConfig
//     factory; registerQueue for the named queue; per-processor logger token.
//
//   - Deliberately NOT imported: @aramo/ai-draft / any LLM substrate — this poll
//     performs no extraction in P0.2 (ADR-0015 Decision 10 boundary trivially
//     held; enforced by src/tests/no-llm-boundary.spec.ts).
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
    BullModule.registerQueue({ name: COLD_INGEST_EXTRACTION_QUEUE_NAME }),
  ],
  providers: [
    ColdIngestExtractionProcessor,
    {
      provide: 'ColdIngestExtractionProcessorLogger',
      useFactory: () => createAramoLogger(ColdIngestExtractionProcessor.name),
    },
  ],
  exports: [ColdIngestExtractionProcessor],
})
export class ColdIngestExtractionModule {}
