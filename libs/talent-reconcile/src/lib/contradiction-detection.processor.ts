import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';
import { TalentRecordReconcileRepository } from '@aramo/talent-record';

import { ContradictionDetectionService } from './contradiction-detection.service.js';
import {
  CONTRADICTION_DETECTION_BATCH_SIZE,
  CONTRADICTION_DETECTION_QUEUE_NAME,
} from './contradiction-detection.queue.constants.js';

// Promotion Gate Slice-B2 — the contradiction-detection poll (subject-poll
// shape, the B1/extraction precedent). A second WorkerHost in libs/talent-
// reconcile, sibling to the reconcile poll.
//
//   - Work signal = a B1 PendingContradictionRow with status='pending'
//     (@@index([tenant_id, status])). Each tick drains up to N, joined to the
//     incumbent EvidenceRecord, and raises the L2 contradiction per row.
//   - The service never throws — a transient failure leaves the row pending;
//     one bad row never aborts the batch.
//   - Idempotency: the status pending→resolved flip (a resolved row is never
//     re-selected → no duplicate links).
//
// Redis-gated bootstrap mirrors the reconcile / extraction / canonicalize polls
// (ADR-0018 Decision 1): silent when Redis is unconfigured.

export interface ContradictionDetectionTickInput {
  override_batch_size?: number;
}

interface DrainResult {
  attempted: number;
  contradicted: number;
  no_incumbent: number;
  transient_retry: number;
}

@Processor(CONTRADICTION_DETECTION_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class ContradictionDetectionProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly service: ContradictionDetectionService,
    private readonly reconcileRepo: TalentRecordReconcileRepository,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('ContradictionDetectionProcessorLogger')
    private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(job: Job<ContradictionDetectionTickInput>): Promise<void> {
    const batchSize =
      job.data.override_batch_size ?? CONTRADICTION_DETECTION_BATCH_SIZE;
    const result = await this.drainBatch({ batchSize, jobId: job.id ?? null });
    this.logger.log({
      event: 'contradiction_detection_tick_completed',
      job_id: job.id ?? null,
      batch_size: batchSize,
      attempted: result.attempted,
      contradicted: result.contradicted,
      no_incumbent: result.no_incumbent,
      transient_retry: result.transient_retry,
    });
  }

  // Exposed for the integration spec — the drain seam end-to-end without a real
  // worker (the reconcile / extraction precedent).
  async drainBatch(args: { batchSize: number; jobId: string | null }): Promise<DrainResult> {
    const pending = await this.reconcileRepo.findPendingContradictions({
      limit: args.batchSize,
    });

    if (pending.length === 0) {
      this.logger.debug({ event: 'contradiction_detection_tick_empty', job_id: args.jobId });
      return { attempted: 0, contradicted: 0, no_incumbent: 0, transient_retry: 0 };
    }

    let contradicted = 0;
    let no_incumbent = 0;
    let transient_retry = 0;
    for (const row of pending) {
      const result = await this.service.resolvePending(row);
      if (result.outcome === 'contradicted') contradicted += 1;
      else if (result.outcome === 'no_incumbent') no_incumbent += 1;
      else transient_retry += 1;
    }

    return { attempted: pending.length, contradicted, no_incumbent, transient_retry };
  }

  onApplicationBootstrap(): void {
    if (!this.redisConfig.isConfigured) {
      this.logger.warn({
        event: 'contradiction_detection_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
