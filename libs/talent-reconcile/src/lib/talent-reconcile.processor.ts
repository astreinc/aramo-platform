import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';
import { TalentTrustService } from '@aramo/talent-trust';

import { TalentReconcileService } from './talent-reconcile.service.js';
import {
  TALENT_RECONCILE_BATCH_SIZE,
  TALENT_RECONCILE_MAX_ATTEMPTS,
  TALENT_RECONCILE_QUEUE_NAME,
} from './talent-reconcile.queue.constants.js';

// Promotion Gate Slice-B1 — the reconcile poll (subject-poll shape, the
// cold-ingest-extraction / canonicalization-trigger precedent).
//
//   - The work signal is a PROMOTED subject (ATS_TALENT_RECORD ref) whose
//     immutable EvidenceRecord history has grown past its reconcile watermark.
//     findSubjectsNeedingReconcile expresses that as a single talent_trust query.
//   - Each tick drains up to N such subjects (oldest first) and enriches each.
//     The service never throws — a transient failure bumps the attempt and
//     leaves the watermark un-advanced; one bad subject never aborts the batch.
//   - Idempotency: (a) the poll filters out already-watermarked subjects;
//     (b) enrichment is fill-null/align/dedupe convergent; (c) the watermark is
//     the last write.
//
// Lifecycle mirrors the other poll processors (ADR-0018 Decision 1):
// manualRegistration + onApplicationBootstrap gate on RedisConnectionConfig —
// silent when Redis is unconfigured; registers only when REDIS_URL is present.

export interface TalentReconcileTickInput {
  override_batch_size?: number;
}

interface DrainResult {
  attempted: number;
  reconciled: number;
  record_gone: number;
  transient_retry: number;
}

@Processor(TALENT_RECONCILE_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class TalentReconcileProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly service: TalentReconcileService,
    private readonly trust: TalentTrustService,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('TalentReconcileProcessorLogger')
    private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(job: Job<TalentReconcileTickInput>): Promise<void> {
    const batchSize = job.data.override_batch_size ?? TALENT_RECONCILE_BATCH_SIZE;
    const result = await this.drainBatch({ batchSize, jobId: job.id ?? null });
    this.logger.log({
      event: 'talent_reconcile_tick_completed',
      job_id: job.id ?? null,
      batch_size: batchSize,
      attempted: result.attempted,
      reconciled: result.reconciled,
      record_gone: result.record_gone,
      transient_retry: result.transient_retry,
    });
  }

  // Exposed for the integration spec — the drain seam end-to-end without a real
  // worker (the extraction/canonicalize precedent).
  async drainBatch(args: { batchSize: number; jobId: string | null }): Promise<DrainResult> {
    const subjects = await this.trust.findSubjectsNeedingReconcile({
      limit: args.batchSize,
      maxAttempts: TALENT_RECONCILE_MAX_ATTEMPTS,
    });

    if (subjects.length === 0) {
      this.logger.debug({ event: 'talent_reconcile_tick_empty', job_id: args.jobId });
      return { attempted: 0, reconciled: 0, record_gone: 0, transient_retry: 0 };
    }

    let reconciled = 0;
    let record_gone = 0;
    let transient_retry = 0;
    for (const subject of subjects) {
      const result = await this.service.reconcileSubject(subject);
      if (result.outcome === 'reconciled') reconciled += 1;
      else if (result.outcome === 'record_gone') record_gone += 1;
      else transient_retry += 1;
    }

    return { attempted: subjects.length, reconciled, record_gone, transient_retry };
  }

  onApplicationBootstrap(): void {
    if (!this.redisConfig.isConfigured) {
      this.logger.warn({
        event: 'talent_reconcile_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
