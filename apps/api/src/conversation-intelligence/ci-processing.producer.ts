import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { RedisConnectionConfig } from '@aramo/common';

import {
  CI_PROCESSING_QUEUE_NAME,
  CI_PROCESSING_RECONCILE_INTERVAL_MS,
  CI_PROCESSING_RECONCILE_JOB,
  CI_PROCESSING_RECONCILE_JOB_ID,
  CI_PROCESSING_RUN_JOB,
} from './ci-processing.queue.constants.js';

// CI-B6P §14/§19/§20 — the CI-processing producer. Enqueues per-run work jobs
// (identifiers only) and schedules the repeatable recovery tick. Redis-gated:
// when REDIS_URL is absent (CI/local), enqueue is a silent no-op (the durable
// run remains recoverable via the reconcile scan on a Redis-configured boot).
@Injectable()
export class CiProcessingProducer {
  constructor(
    @InjectQueue(CI_PROCESSING_QUEUE_NAME) private readonly queue: Queue,
    private readonly redisConfig: RedisConnectionConfig,
  ) {}

  /** Enqueue a run for processing. Idempotent jobId → duplicate signals dedup. */
  async enqueueRun(runId: string, tenantId: string): Promise<void> {
    if (!this.redisConfig.isConfigured) return;
    await this.queue.add(
      CI_PROCESSING_RUN_JOB,
      { run_id: runId, tenant_id: tenantId },
      // BullMQ forbids ':' in custom job ids — use a plain separator.
      { jobId: `${CI_PROCESSING_RUN_JOB}-${runId}`, removeOnComplete: true, removeOnFail: 100 },
    );
  }

  /** Register the repeatable recovery tick (dedup by fixed jobId). */
  async scheduleReconcile(): Promise<void> {
    if (!this.redisConfig.isConfigured) return;
    await this.queue.add(
      CI_PROCESSING_RECONCILE_JOB,
      {},
      {
        jobId: CI_PROCESSING_RECONCILE_JOB_ID,
        repeat: { every: CI_PROCESSING_RECONCILE_INTERVAL_MS },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }
}
