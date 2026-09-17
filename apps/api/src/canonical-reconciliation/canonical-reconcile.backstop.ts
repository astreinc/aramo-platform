import { Inject, Injectable } from '@nestjs/common';
import { type AramoLogger } from '@aramo/common';
import { TalentCanonicalCoverageRepository } from '@aramo/talent-evidence';
import {
  CANONICAL_RECONCILE_BACKSTOP_BATCH,
  CanonicalReconcileProducer,
} from '@aramo/canonical-reconcile';

import { CanonicalReconcileConfig } from './canonical-reconcile.config.js';

// SKILL-TAX Canonical Reconciliation Activation — the Talent backstop. Recovers
// talents whose confirmed-create (or examine-lazy-created) evidence never got a
// reconcile enqueue (Redis down at write time, missed job, or the matching path
// which by ruling emits NO enqueue). Watermark-guarded (new/changed-only) and
// bounded per tick. It only RE-ENQUEUES (never reconciles inline) — the worker
// does the resolution. Idempotent: already-canonicalized rows are excluded by
// the `canonicalized_at IS NULL` eligibility.
@Injectable()
export class CanonicalReconcileBackstop {
  constructor(
    private readonly coverage: TalentCanonicalCoverageRepository,
    private readonly producer: CanonicalReconcileProducer,
    private readonly config: CanonicalReconcileConfig,
    @Inject('CanonicalReconcileBackstopLogger') private readonly logger: AramoLogger,
  ) {}

  async run(): Promise<{ discovered: number; enqueued: number }> {
    return this.findAndEnqueueEligible(
      this.config.activationWatermark,
      CANONICAL_RECONCILE_BACKSTOP_BATCH,
    );
  }

  // Exposed for direct integration testing of the watermark boundary.
  async findAndEnqueueEligible(
    since: Date,
    limit: number,
  ): Promise<{ discovered: number; enqueued: number }> {
    const eligible = await this.coverage.findTalentsWithUnreconciledEvidence({ since, limit });
    let enqueued = 0;
    for (const t of eligible) {
      await this.producer.enqueueTalent(t.tenant_id, t.talent_id);
      enqueued += 1;
    }
    this.logger.log({
      event: 'canonical_reconcile_backstop_scan',
      discovered: eligible.length,
      enqueued,
    });
    return { discovered: eligible.length, enqueued };
  }
}
