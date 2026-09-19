import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';

import { COLD_INGEST_EXTRACTION_QUEUE_NAME } from './cold-ingest-extraction.queue.constants.js';

// Cold-Ingest Extraction — PARKED (TI-1F P0.2).
//
// Heuristic résumé FACT extraction is RETIRED (governed LLM is the SOLE
// production résumé fact extractor; …-TI-1F-…-v1_0-LOCKED §4-D). Cold-ingest is
// PARKED pending a separate architecture review and is NOT wired into the TI-1F
// recruiter résumé flow.
//
// This worker is therefore INERT: a tick performs NO extraction — it reads no
// arrivals, produces no Talent facts/evidence, stamps no extract-once marker,
// and records no retry markers. The inbound/staging substrate (the ingestion
// RawPayloadReference rows + the IngestionRepository poll) is left intact and
// untouched; resolved arrivals simply remain STAGED for the future review. The
// Redis-gated worker registration is retained as the dormant seam.

@Processor(COLD_INGEST_EXTRACTION_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class ColdIngestExtractionProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('ColdIngestExtractionProcessorLogger')
    private readonly logger: AramoLogger,
  ) {
    super();
  }

  // INERT tick — cold-ingest is PARKED. No extraction, no arrival reads, no
  // writes, no markers. Logged for observability only.
  async process(job: Job): Promise<void> {
    this.logger.log({
      event: 'cold_ingest_extraction_parked',
      job_id: job.id ?? null,
    });
  }

  onApplicationBootstrap(): void {
    if (!this.redisConfig.isConfigured) {
      this.logger.warn({
        event: 'cold_ingest_extraction_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
