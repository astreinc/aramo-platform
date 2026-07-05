import { Inject, Injectable } from '@nestjs/common';
import { type AramoLogger } from '@aramo/common';
import {
  TalentRecordReconcileRepository,
  type PendingContradictionForResolution,
} from '@aramo/talent-record';
import { TalentTrustService } from '@aramo/talent-trust';

// Promotion Gate Slice-B2 — resolve one pending contradiction. Above the I15
// wall (scope:ats): reads the ats pending store + incumbent provenance, writes
// the cip trust ledger via contradict(). L3 TalentRecord values are NEVER
// touched — B2 only raises the L2 signal + flips the pending row.
//
// Ordering is load-bearing: contradict() FIRST, markResolved LAST. contradict()
// is at-least-once (not link-idempotent); the resolved flip is the idempotency
// gate for RE-POLLS (a resolved row is never selected again → no duplicate
// links). A crash strictly between the two writes leaves the row pending → a
// re-poll re-contradicts (a rare duplicate link; the TrustState rollup stays
// convergent — open_contradiction_count counts distinct CONTRADICTED records,
// not links). That narrow cross-client window is the accepted backlog-B1 class.

export type ContradictionOutcome =
  | 'contradicted'
  | 'no_incumbent'
  | 'transient_retry';

export interface ContradictionResult {
  pending_id: string;
  outcome: ContradictionOutcome;
}

@Injectable()
export class ContradictionDetectionService {
  constructor(
    private readonly trust: TalentTrustService,
    private readonly reconcileRepo: TalentRecordReconcileRepository,
    @Inject('ContradictionDetectionServiceLogger')
    private readonly logger: AramoLogger,
  ) {}

  async resolvePending(
    row: PendingContradictionForResolution,
  ): Promise<ContradictionResult> {
    // Invariant violation — the field has no incumbent provenance (create +
    // null-fill should always write it). DO NOT guess an incumbent; leave the
    // row pending and surface it (a metric to chase, not a silent drop).
    if (row.incumbent_evidence_id === null) {
      this.logger.warn({
        event: 'contradiction_detection_no_incumbent',
        pending_id: row.id,
        tenant_id: row.tenant_id,
        talent_record_id: row.talent_record_id,
        field_name: row.field_name,
      });
      return { pending_id: row.id, outcome: 'no_incumbent' };
    }

    try {
      // Raise the L2 contradiction — the incumbent (current L3 value's evidence)
      // is CONTRADICTED by the newer differing arrival. Reason is PII-free (no
      // field values — only the field name + the pending-row id).
      await this.trust.contradict(
        row.incumbent_evidence_id,
        row.new_evidence_id,
        `promotion-reconcile: field '${row.field_name}' occupied by newer differing evidence (pending ${row.id})`,
      );
      // Idempotency gate LAST — a resolved row is never re-polled.
      await this.reconcileRepo.markContradictionResolved(row.id);
      this.logger.log({
        event: 'contradiction_detection_raised',
        pending_id: row.id,
        tenant_id: row.tenant_id,
        talent_record_id: row.talent_record_id,
        field_name: row.field_name,
      });
      return { pending_id: row.id, outcome: 'contradicted' };
    } catch (err) {
      // Transient (DB) failure — leave the row pending; the next tick re-picks.
      this.logger.warn({
        event: 'contradiction_detection_transient_failure',
        pending_id: row.id,
        tenant_id: row.tenant_id,
        error_message: err instanceof Error ? err.message : String(err),
      });
      return { pending_id: row.id, outcome: 'transient_retry' };
    }
  }
}
