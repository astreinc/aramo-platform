import { Inject, Injectable } from '@nestjs/common';
import { type AramoLogger } from '@aramo/common';
import {
  TalentRecordRepository,
  TalentRecordReconcileRepository,
} from '@aramo/talent-record';
import {
  TalentTrustService,
  type ReconcileTargetRow,
} from '@aramo/talent-trust';

import { computeReconcilePlan } from './reconcile-plan.js';

// Promotion Gate Slice-B1 — the per-subject reconcile (enrich-only). Above the
// I15 wall (scope:ats): reads the cip trust ledger (TalentTrustService) and
// writes the ats heart (TalentRecord + its projection annotations). The pure
// plan (reconcile-plan.ts) decides WHAT; this applies it and advances the
// watermark. Never throws — a transient write failure bumps the attempt and
// leaves the watermark un-advanced (the next tick re-picks; bounded).

export type ReconcileOutcome = 'reconciled' | 'record_gone' | 'transient_retry';

export interface ReconcileResult {
  subject_id: string;
  outcome: ReconcileOutcome;
  fields_filled: number;
  contradictions_recorded: number;
}

@Injectable()
export class TalentReconcileService {
  constructor(
    private readonly trust: TalentTrustService,
    private readonly talentRecords: TalentRecordRepository,
    private readonly reconcileRepo: TalentRecordReconcileRepository,
    @Inject('TalentReconcileServiceLogger')
    private readonly logger: AramoLogger,
  ) {}

  async reconcileSubject(target: ReconcileTargetRow): Promise<ReconcileResult> {
    const { subject_id, tenant_id, talent_record_id } = target;
    const subjectRef = {
      tenant_id,
      ref_type: 'ATS_TALENT_RECORD' as const,
      ref_id: talent_record_id,
    };

    try {
      const record = await this.talentRecords.findById({ tenant_id, id: talent_record_id });
      if (record === null) {
        // The linked record was deleted — nothing to project. Stamp so the
        // subject drops out of the poll (a dangling ref is not an error here).
        await this.trust.markReconciled(subject_id);
        this.logger.warn({
          event: 'talent_reconcile_record_gone',
          subject_id,
          tenant_id,
          talent_record_id,
        });
        return { subject_id, outcome: 'record_gone', fields_filled: 0, contradictions_recorded: 0 };
      }

      // ALL of the subject's declared evidence (the L2 history to project from).
      const evidence = await this.trust.getEvidence(subjectRef);
      const plan = computeReconcilePlan(record, evidence);

      // Enrich the flat row (fill-null + append) — only the computed patch.
      await this.reconcileRepo.applyEnrichment({ tenant_id, talent_record_id, patch: plan.patch });

      // I10 provenance by reference — which EvidenceRecord backs each field.
      for (const p of plan.provenance) {
        await this.reconcileRepo.upsertFieldProvenance({
          tenant_id,
          talent_record_id,
          field_name: p.field_name,
          evidence_id: p.evidence_id,
        });
      }

      // Occupied + newer-differing → recorded for B2 (never acted on here).
      for (const c of plan.contradictions) {
        await this.reconcileRepo.recordPendingContradiction({
          tenant_id,
          talent_record_id,
          field_name: c.field_name,
          new_evidence_id: c.new_evidence_id,
        });
      }

      // Watermark LAST — advances past the evidence just projected (convergent;
      // a re-run before this point is idempotent — fill-null becomes occupied-
      // same, provenance upserts, pending contradictions dedupe).
      await this.trust.markReconciled(subject_id);

      this.logger.log({
        event: 'talent_reconcile_completed',
        subject_id,
        tenant_id,
        talent_record_id,
        fields_filled: Object.keys(plan.patch).length,
        contradictions_recorded: plan.contradictions.length,
      });
      return {
        subject_id,
        outcome: 'reconciled',
        fields_filled: Object.keys(plan.patch).length,
        contradictions_recorded: plan.contradictions.length,
      };
    } catch (err) {
      // Transient (DB) failure — leave the watermark un-advanced, bump the
      // attempt; a later tick re-picks (bounded by the cap).
      await this.trust.bumpReconcileAttempt(subject_id);
      this.logger.warn({
        event: 'talent_reconcile_transient_failure',
        subject_id,
        tenant_id,
        talent_record_id,
        error_message: err instanceof Error ? err.message : String(err),
      });
      return { subject_id, outcome: 'transient_retry', fields_filled: 0, contradictions_recorded: 0 };
    }
  }
}
