import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';

import {
  CANONICAL_RECONCILE_BACKSTOP_INTERVAL_MS,
  CANONICAL_RECONCILE_BACKSTOP_JOB,
  CANONICAL_RECONCILE_BACKSTOP_JOB_ID,
  CANONICAL_RECONCILE_JOB,
  CANONICAL_RECONCILE_QUEUE_NAME,
  type CanonicalReconcileJobData,
} from './canonical-reconcile.queue.constants.js';

// SKILL-TAX Canonical Reconciliation Activation — the best-effort push-enqueue
// producer. Called AFTER a domain write commits (confirmed Talent CREATE;
// requisition confirmProfile). Two hard guarantees so a user-facing write is
// NEVER coupled to canonicalization:
//   1. Redis-gated — if REDIS_URL is absent, enqueue is a silent no-op (the
//      backstop recovers eligible talents on a Redis-configured boot).
//   2. Best-effort — any enqueue error is logged and swallowed; it can never
//      throw back into the domain write. A missed enqueue is recovered by the
//      backstop (talent) or a later re-confirm (requisition).
// Idempotent jobId → duplicate signals dedup while pending; the workers are
// idempotent so duplicate delivery is harmless.
@Injectable()
export class CanonicalReconcileProducer {
  constructor(
    @InjectQueue(CANONICAL_RECONCILE_QUEUE_NAME) private readonly queue: Queue,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('CanonicalReconcileProducerLogger') private readonly logger: AramoLogger,
  ) {}

  async enqueueTalent(tenantId: string, talentId: string): Promise<void> {
    await this.enqueue(
      { kind: 'TALENT', tenant_id: tenantId, talent_id: talentId },
      `talent-${talentId}`,
    );
  }

  async enqueueRequisition(
    tenantId: string,
    requisitionId: string,
    goldenProfileId: string,
  ): Promise<void> {
    await this.enqueue(
      {
        kind: 'REQUISITION',
        tenant_id: tenantId,
        requisition_id: requisitionId,
        golden_profile_id: goldenProfileId,
      },
      `requisition-${goldenProfileId}`,
    );
  }

  // SKILL-TAX-1F-B1 — REQUIRED (non-swallowing) enqueue variants for the durable
  // correction processor, whose COMPLETED gate demands the reconcile enqueue
  // actually succeeded. These THROW on a missing Redis or a queue.add failure so
  // the caller can leave the correction task retryable. The best-effort methods
  // above are unchanged — existing business-write callers keep their swallow.
  async enqueueTalentRequired(tenantId: string, talentId: string): Promise<void> {
    await this.enqueueRequired(
      { kind: 'TALENT', tenant_id: tenantId, talent_id: talentId },
      `talent-${talentId}`,
    );
  }

  async enqueueRequisitionRequired(
    tenantId: string,
    requisitionId: string,
    goldenProfileId: string,
  ): Promise<void> {
    await this.enqueueRequired(
      {
        kind: 'REQUISITION',
        tenant_id: tenantId,
        requisition_id: requisitionId,
        golden_profile_id: goldenProfileId,
      },
      `requisition-${goldenProfileId}`,
    );
  }

  private async enqueueRequired(data: CanonicalReconcileJobData, jobKey: string): Promise<void> {
    if (!this.redisConfig.isConfigured) {
      throw new Error('reconcile queue unavailable (REDIS_URL not configured)');
    }
    // No try/catch: a queue.add failure PROPAGATES so the correction task is not
    // falsely completed. Same idempotent jobId as the best-effort path.
    await this.queue.add(CANONICAL_RECONCILE_JOB, data, {
      jobId: `${CANONICAL_RECONCILE_JOB}-${jobKey}`,
      removeOnComplete: true,
      removeOnFail: 100,
    });
  }

  private async enqueue(data: CanonicalReconcileJobData, jobKey: string): Promise<void> {
    if (!this.redisConfig.isConfigured) return; // silent no-op without Redis
    try {
      await this.queue.add(CANONICAL_RECONCILE_JOB, data, {
        // BullMQ forbids ':' in custom job ids — use a plain separator.
        jobId: `${CANONICAL_RECONCILE_JOB}-${jobKey}`,
        removeOnComplete: true,
        removeOnFail: 100,
      });
    } catch (err) {
      // Best-effort: a failed enqueue must NEVER fail the domain write.
      this.logger.warn({
        event: 'canonical_reconcile_enqueue_failed',
        kind: data.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Register the repeatable backstop tick (dedup by fixed jobId). Best-effort.
  async scheduleBackstop(): Promise<void> {
    if (!this.redisConfig.isConfigured) return;
    try {
      await this.queue.add(
        CANONICAL_RECONCILE_BACKSTOP_JOB,
        {},
        {
          jobId: CANONICAL_RECONCILE_BACKSTOP_JOB_ID,
          repeat: { every: CANONICAL_RECONCILE_BACKSTOP_INTERVAL_MS },
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
    } catch (err) {
      this.logger.warn({
        event: 'canonical_reconcile_backstop_schedule_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
