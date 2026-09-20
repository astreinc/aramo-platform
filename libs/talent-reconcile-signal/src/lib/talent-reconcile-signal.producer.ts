import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';

import {
  TALENT_RECONCILE_BACKSTOP_INTERVAL_MS,
  TALENT_RECONCILE_BACKSTOP_JOB,
  TALENT_RECONCILE_BACKSTOP_JOB_ID,
  TALENT_RECONCILE_JOB,
  TALENT_RECONCILE_QUEUE_NAME,
  type TalentReconcileJobData,
} from './talent-reconcile-signal.queue.constants.js';

// TALENT-INTEL-1 TI-1F-C — the best-effort Talent-profile reconcile PUSH producer
// (directive §4-H). Called AFTER the authoritative promotion commits on CONFIRM
// (and on confirmed CREATE). It is the SEPARATE architecture from the SKILL
// canonical reconcile (CanonicalReconcileProducer) — the two signals coexist and
// MUST NOT merge; a CONFIRM emits BOTH.
//
// Two hard guarantees so a user-facing write is NEVER coupled to reconciliation:
//   1. Redis-gated — no REDIS_URL → enqueue is a silent no-op (the backstop
//      recovers eligible subjects on a Redis-configured boot).
//   2. Best-effort — any enqueue error is logged and swallowed; it can never
//      throw back into the domain write. A missed push is recovered by the
//      watermark backstop tick.
// Idempotent jobId → duplicate signals dedup while pending; the worker is
// idempotent (watermark-driven) so duplicate delivery is harmless.
@Injectable()
export class TalentReconcileProducer {
  constructor(
    @InjectQueue(TALENT_RECONCILE_QUEUE_NAME) private readonly queue: Queue,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('TalentReconcileProducerLogger') private readonly logger: AramoLogger,
  ) {}

  async enqueueTalent(tenantId: string, talentId: string): Promise<void> {
    const data: TalentReconcileJobData = {
      kind: 'TALENT',
      tenant_id: tenantId,
      talent_id: talentId,
    };
    if (!this.redisConfig.isConfigured) return; // silent no-op without Redis
    try {
      await this.queue.add(TALENT_RECONCILE_JOB, data, {
        // BullMQ forbids ':' in custom job ids — use a plain separator.
        jobId: `${TALENT_RECONCILE_JOB}-talent-${talentId}`,
        removeOnComplete: true,
        removeOnFail: 100,
      });
    } catch (err) {
      // Best-effort: a failed enqueue must NEVER fail the domain write.
      this.logger.warn({
        event: 'talent_reconcile_enqueue_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Register the repeatable backstop tick (dedup by fixed jobId). Best-effort.
  // This gives the existing (dormant) watermark-poll worker a recovery mechanism.
  async scheduleBackstop(): Promise<void> {
    if (!this.redisConfig.isConfigured) return;
    try {
      await this.queue.add(
        TALENT_RECONCILE_BACKSTOP_JOB,
        {},
        {
          jobId: TALENT_RECONCILE_BACKSTOP_JOB_ID,
          repeat: { every: TALENT_RECONCILE_BACKSTOP_INTERVAL_MS },
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
    } catch (err) {
      this.logger.warn({
        event: 'talent_reconcile_backstop_schedule_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
