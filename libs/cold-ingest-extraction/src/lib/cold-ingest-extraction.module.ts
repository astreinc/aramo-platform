import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import {
  CommonModule,
  createAramoLogger,
  RedisConnectionConfig,
} from '@aramo/common';
import { IngestionModule } from '@aramo/ingestion';
import { ResumeParseModule } from '@aramo/resume-parse';
import { TalentTrustModule } from '@aramo/talent-trust';

import { ColdIngestExtractionService } from './cold-ingest-extraction.service.js';
import { ColdIngestExtractionProcessor } from './cold-ingest-extraction.processor.js';
import { COLD_INGEST_EXTRACTION_QUEUE_NAME } from './cold-ingest-extraction.queue.constants.js';

// Cold-Ingest Extraction — the poll module.
//
//   - Consumer-direction leaf. Imports (all scope:cip — I15 CIP⊥ATS wall
//     clean, no ats edge):
//       IngestionModule   → IngestionRepository (poll + extract-once marker).
//       ResumeParseModule → ResumeParserService (deterministic parse, no LLM).
//       TalentTrustModule → TalentTrustService (declared-evidence write to the
//                           resolved subject).
//
//   - NO controller (a background poll; the canonicalization-trigger precedent).
//
//   - The ColdIngestExtractionProcessor is a BullMQ tick worker that drains
//     resolved-but-unextracted RawPayloadReference rows. BullModule wiring
//     mirrors CanonicalizationModule verbatim: forRootAsync with
//     manualRegistration + lazyConnect + RedisConnectionConfig factory;
//     registerQueue for the named queue; per-processor logger factory token.
//
//   - Deliberately NOT imported: @aramo/ai-draft / any LLM substrate — this
//     poll uses the deterministic resume parser only (ADR-0015 Decision 10;
//     enforced by src/tests/no-llm-boundary.spec.ts).
@Module({
  imports: [
    CommonModule,
    IngestionModule,
    ResumeParseModule,
    TalentTrustModule,
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
    ColdIngestExtractionService,
    ColdIngestExtractionProcessor,
    {
      provide: 'ColdIngestExtractionServiceLogger',
      useFactory: () => createAramoLogger(ColdIngestExtractionService.name),
    },
    {
      provide: 'ColdIngestExtractionProcessorLogger',
      useFactory: () => createAramoLogger(ColdIngestExtractionProcessor.name),
    },
  ],
  exports: [ColdIngestExtractionService, ColdIngestExtractionProcessor],
})
export class ColdIngestExtractionModule {}
