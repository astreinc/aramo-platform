import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';
import { IngestionRepository } from '@aramo/ingestion';

import { ColdIngestExtractionService } from './cold-ingest-extraction.service.js';
import {
  COLD_INGEST_EXTRACTION_BATCH_SIZE,
  COLD_INGEST_EXTRACTION_MAX_ATTEMPTS,
  COLD_INGEST_EXTRACTION_QUEUE_NAME,
} from './cold-ingest-extraction.queue.constants.js';

// Cold-Ingest Extraction — the production poll from resolved-arrival →
// declared identity evidence.
//
// Design (mirrors CanonicalizationTriggerProcessor — the substrate-aligned
// polling-outbox shape):
//
//   - The resolved-but-unextracted RawPayloadReference row IS the trigger's
//     "work-to-do" signal (resolved_subject_id NOT NULL + extraction_done_at
//     NULL + extraction_attempts < cap). No separate outbox table.
//
//   - Each tick: fetch up to N such arrivals (oldest first) and run
//     ColdIngestExtractionService.extractArrival() per row. That service
//     never throws — a transient parse failure is caught, the attempt
//     counter bumped, and the gate left NULL so a later tick re-picks
//     (bounded). One bad arrival never aborts the batch.
//
//   - Idempotency: two layers — (a) the poll filters out already-done rows
//     (extraction_done_at IS NULL); (b) the marker is stamped as the LAST
//     write after the evidence write, so a race re-fire at worst duplicates
//     a declared record (convergent recompute).
//
// Lifecycle mirrors CanonicalizationTriggerProcessor / OutboxPublisherProcessor
// (ADR-0018 Decision 1): manualRegistration + onApplicationBootstrap gate on
// RedisConnectionConfig.isConfigured — boot is silent when Redis is
// unconfigured; the worker registers only when REDIS_URL is present.

export interface ColdIngestExtractionTickInput {
  // Reserved for future per-batch-size overrides.
  override_batch_size?: number;
}

interface DrainResult {
  attempted: number;
  extracted: number;
  done_no_identity: number;
  transient_retry: number;
}

@Processor(COLD_INGEST_EXTRACTION_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class ColdIngestExtractionProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly service: ColdIngestExtractionService,
    private readonly ingestionRepo: IngestionRepository,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('ColdIngestExtractionProcessorLogger')
    private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(job: Job<ColdIngestExtractionTickInput>): Promise<void> {
    const batchSize =
      job.data.override_batch_size ?? COLD_INGEST_EXTRACTION_BATCH_SIZE;

    const result = await this.drainBatch({ batchSize, jobId: job.id ?? null });

    this.logger.log({
      event: 'cold_ingest_extraction_tick_completed',
      job_id: job.id ?? null,
      batch_size: batchSize,
      attempted: result.attempted,
      extracted: result.extracted,
      done_no_identity: result.done_no_identity,
      transient_retry: result.transient_retry,
    });
  }

  // Exposed for the integration spec — exercises the drain seam end-to-end
  // without standing up a real BullMQ worker (the canonicalize precedent).
  async drainBatch(args: {
    batchSize: number;
    jobId: string | null;
  }): Promise<DrainResult> {
    const arrivals = await this.ingestionRepo.findArrivalsNeedingExtraction({
      limit: args.batchSize,
      maxAttempts: COLD_INGEST_EXTRACTION_MAX_ATTEMPTS,
    });

    if (arrivals.length === 0) {
      this.logger.debug({
        event: 'cold_ingest_extraction_tick_empty',
        job_id: args.jobId,
      });
      return { attempted: 0, extracted: 0, done_no_identity: 0, transient_retry: 0 };
    }

    let extracted = 0;
    let done_no_identity = 0;
    let transient_retry = 0;

    // Per-arrival isolation — the service never throws; each outcome is
    // counted. A transient failure leaves the row for the next tick.
    for (const arrival of arrivals) {
      const result = await this.service.extractArrival(arrival);
      if (result.outcome === 'extracted') extracted += 1;
      else if (result.outcome === 'done_no_identity') done_no_identity += 1;
      else transient_retry += 1;
    }

    return {
      attempted: arrivals.length,
      extracted,
      done_no_identity,
      transient_retry,
    };
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
