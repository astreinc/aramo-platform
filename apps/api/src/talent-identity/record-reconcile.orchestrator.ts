import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { ConsentRepository } from '@aramo/consent';
import { PipelineRepository } from '@aramo/pipeline';
import { SubmittalRepository } from '@aramo/submittal';
import { EvidenceRepository } from '@aramo/evidence';
import { SelectionRepository } from '@aramo/selection';
import { ExaminationRepository } from '@aramo/examination';
import { TalentEvidenceRepository } from '@aramo/talent-evidence';
import { SavedListRepository } from '@aramo/saved-list';
import { AttachmentRepository } from '@aramo/attachment';
import { ActivityRepository } from '@aramo/activity';
import { TaskRepository } from '@aramo/task';
import { TechnicalScreeningRepository } from '@aramo/technical-screening';
import {
  TalentDuplicateAdvisoryRepository,
  TalentRecordRepository,
  type DuplicateAdvisoryMergeState,
  type DuplicateAdvisoryRow,
} from '@aramo/talent-record';

// RecordReconcileOrchestrator — the RECORD re-home of an APPROVED within-tenant
// duplicate advisory. ATI-SEP-1 T10 WP2 (Addenda A2 F-1 / A3): rebuilt over
// TalentRecords + the ATS talent_duplicate_advisory table only — no trust
// subject, no trust recompute, no identity-index cluster carry. The TR-2a-B3b
// merge/re-home semantics are kept verbatim:
//
//   * R_S (the surviving record) stays live; R_L (the other) is SUPERSEDED (never
//     deleted — the row persists as the un-merge restore source);
//   * every ATS holder keyed by talent_record_id is re-pointed R_L → R_S through
//     its OWN repository method (consent ledger + audit FIRST, so the send-gate
//     becomes survivor-visible early), collision rows recorded verbatim;
//   * each step is checkpointed in the advisory's merge_state → a crash leaves a
//     resumable APPROVED-but-incomplete advisory (approve again resumes);
//   * reversal re-points exactly the recorded rows back, re-creates collision
//     rows, deletes the synthetic consent grants, lifts supersession, and lists
//     post-merge accretions for human triage (never auto-redistributed).
//
// Fail-closed pre-flight (E6 §5.2): a live/live pipeline episode conflict for the
// same requisition refuses BEFORE any mutation (409 PIPELINE_RECONCILE_LIVE_CONFLICT).

// The uniform operational-holder repoint contract. Every domain repo implements
// this identically; the orchestrator sweeps them in a loop.
interface OperationalRepoint {
  repointTalentRecordRefs(args: {
    tenant_id: string;
    from_record_id: string;
    to_record_id: string;
    only_ids?: string[];
  }): Promise<{ repointed_ids: string[]; removed_rows: unknown[] }>;
}

// The collision holders additionally re-create removed rows on reversal.
interface CollisionRepoint extends OperationalRepoint {
  restoreRemovedRows(rows: Array<Record<string, unknown>>): Promise<void>;
}

export interface ReverseResult {
  advisory: DuplicateAdvisoryRow;
  // Rows created against R_S AFTER the re-home — NOT auto-redistributed; handed
  // to a human for triage. Shape: [{ domain, ids: string[] }].
  post_merge_accretions: Array<{ domain: string; ids: string[] }>;
}

const EMPTY_STATE: DuplicateAdvisoryMergeState = { sweep_steps: [], collision_records: [] };

@Injectable()
export class RecordReconcileOrchestrator {
  private readonly logger = new Logger(RecordReconcileOrchestrator.name);

  constructor(
    private readonly advisories: TalentDuplicateAdvisoryRepository,
    private readonly talentRecords: TalentRecordRepository,
    private readonly consent: ConsentRepository,
    private readonly pipeline: PipelineRepository,
    private readonly submittal: SubmittalRepository,
    private readonly evidence: EvidenceRepository,
    private readonly selection: SelectionRepository,
    private readonly examination: ExaminationRepository,
    private readonly talentEvidence: TalentEvidenceRepository,
    private readonly savedList: SavedListRepository,
    private readonly attachment: AttachmentRepository,
    private readonly activity: ActivityRepository,
    private readonly task: TaskRepository,
    // TIP-E2E INC-3 (directive §10.3) — re-keys ScreeningSession.talent_record_id;
    // publication intents keep their pinned talent_record_id_at_confirm.
    private readonly technicalScreening: TechnicalScreeningRepository,
  ) {}

  // The operational holders, in sweep order (consent's ledger/audit run FIRST,
  // handled specially before this list). Pipeline + saved-list carry collisions.
  private operationalHolders(): Array<{ domain: string; repo: OperationalRepoint }> {
    return [
      { domain: 'pipeline', repo: this.pipeline as unknown as OperationalRepoint },
      { domain: 'submittal', repo: this.submittal as unknown as OperationalRepoint },
      { domain: 'evidence', repo: this.evidence as unknown as OperationalRepoint },
      { domain: 'selection', repo: this.selection as unknown as OperationalRepoint },
      { domain: 'examination', repo: this.examination as unknown as OperationalRepoint },
      { domain: 'talent-evidence', repo: this.talentEvidence as unknown as OperationalRepoint },
      { domain: 'saved-list', repo: this.savedList as unknown as OperationalRepoint },
      { domain: 'attachment', repo: this.attachment as unknown as OperationalRepoint },
      { domain: 'activity', repo: this.activity as unknown as OperationalRepoint },
      { domain: 'task', repo: this.task as unknown as OperationalRepoint },
      { domain: 'technical-screening', repo: this.technicalScreening as unknown as OperationalRepoint },
    ];
  }

  // ---- pre-flight (no mutation) ------------------------------------------------

  /**
   * Refuse a re-home that would manufacture two live episodes for one (tenant,
   * talent, requisition), or that names a record that is no longer live. Runs
   * BEFORE the advisory transitions, so a refusal mutates nothing.
   */
  async preflight(input: {
    tenant_id: string;
    surviving_record_id: string;
    superseded_record_id: string;
    requestId: string;
  }): Promise<void> {
    const { tenant_id, surviving_record_id: recordS, superseded_record_id: recordL } = input;
    const [s, l] = await Promise.all([
      this.talentRecords.findById({ tenant_id, id: recordS }),
      this.talentRecords.findById({ tenant_id, id: recordL }),
    ]);
    if (s === null || l === null || s.record_status === 'superseded' || l.record_status === 'superseded') {
      throw new AramoError(
        'MERGE_SUBJECT_NOT_ACTIVE',
        'Both talent records must be live to approve this advisory',
        409,
        { requestId: input.requestId, details: { surviving_record_id: recordS, superseded_record_id: recordL } },
      );
    }
    const liveConflicts = await this.pipeline.findLiveEpisodeConflicts({
      tenant_id,
      from_record_id: recordL,
      to_record_id: recordS,
    });
    if (liveConflicts.length > 0) {
      throw new AramoError(
        'PIPELINE_RECONCILE_LIVE_CONFLICT',
        'Reconciliation refused: both records hold a live pipeline episode for the same requisition',
        409,
        {
          requestId: input.requestId,
          details: {
            requisition_ids: liveConflicts,
            surviving_record_id: recordS,
            superseded_record_id: recordL,
          },
        },
      );
    }
  }

  // ---- re-home (approve) -------------------------------------------------------------

  /**
   * Drive an APPROVED pair advisory's re-home to completion. Idempotent against
   * the advisory's merge_state checkpoint (resume = call again).
   */
  async reconcile(input: {
    tenant_id: string;
    advisory: DuplicateAdvisoryRow;
    actor_id: string | null;
  }): Promise<DuplicateAdvisoryRow> {
    const { tenant_id, advisory } = input;
    if (advisory.merge_completed_at !== null) return advisory;
    const recordS = advisory.surviving_record_id;
    const recordL = advisory.superseded_record_id;
    if (advisory.status !== 'APPROVED' || recordS === null || recordL === null) return advisory;

    const state: DuplicateAdvisoryMergeState = {
      sweep_steps: [...(advisory.merge_state?.sweep_steps ?? EMPTY_STATE.sweep_steps)],
      collision_records: [...(advisory.merge_state?.collision_records ?? EMPTY_STATE.collision_records)],
    };
    const checkpoint = async (): Promise<void> => {
      await this.advisories.updateMergeState({ tenant_id, id: advisory.id, merge_state: state });
    };

    // Step 1 — supersession (idempotent).
    await this.talentRecords.supersedeRecord({
      tenant_id,
      id: recordL,
      superseded_by_record_id: recordS,
    });

    // Step 2 — sweeps, CONSENT FIRST.
    const done = new Set(state.sweep_steps.map((st) => st.domain));
    if (!done.has('consent-ledger')) {
      const r = await this.consent.repointTalentRecordRefs({
        tenant_id,
        from_record_id: recordL,
        to_record_id: recordS,
        operation_id: advisory.id,
        actor_id: input.actor_id,
      });
      state.sweep_steps.push({ domain: 'consent-ledger', repointed_ids: r.repointed_ids, removed_rows: [] });
      await checkpoint();
    }
    if (!done.has('consent-audit')) {
      await this.consent.appendRecordReconcileAuditEvent({
        tenant_id,
        from_record_id: recordL,
        to_record_id: recordS,
        operation_id: advisory.id,
        actor_id: input.actor_id,
      });
      state.sweep_steps.push({ domain: 'consent-audit', repointed_ids: [], removed_rows: [] });
      await checkpoint();
    }
    for (const { domain, repo } of this.operationalHolders()) {
      if (done.has(domain)) continue;
      const r = await repo.repointTalentRecordRefs({
        tenant_id,
        from_record_id: recordL,
        to_record_id: recordS,
      });
      state.sweep_steps.push({ domain, repointed_ids: r.repointed_ids, removed_rows: r.removed_rows });
      for (const row of r.removed_rows) state.collision_records.push({ domain, row });
      await checkpoint();
    }

    // Step 3 — complete.
    this.logger.log(
      `record re-home complete advisory=${advisory.id} survivor_record=${recordS} superseded_record=${recordL} tenant=${tenant_id}`,
    );
    const completed = await this.advisories.updateMergeState({
      tenant_id,
      id: advisory.id,
      merge_state: state,
      merge_completed_at: new Date(),
    });
    return completed ?? advisory;
  }

  // ---- reversal ----------------------------------------------------------------------

  /**
   * Undo a COMPLETED re-home: lift supersession, re-point back exactly the
   * recorded rows, re-create collision rows, delete the synthetic consent grants,
   * append the reversal audit event. Post-merge accretions are enumerated, never
   * moved. The caller transitions the advisory to REVERSED.
   */
  async reverse(input: {
    tenant_id: string;
    advisory: DuplicateAdvisoryRow;
    actor_id: string;
  }): Promise<Array<{ domain: string; ids: string[] }>> {
    const { tenant_id, advisory } = input;
    const recordS = advisory.surviving_record_id;
    const recordL = advisory.superseded_record_id;
    const accretions: Array<{ domain: string; ids: string[] }> = [];
    if (recordS === null || recordL === null) return accretions;
    const state = advisory.merge_state ?? EMPTY_STATE;

    // 1. Lift supersession — R_L back to live.
    await this.talentRecords.restoreRecord({ tenant_id, id: recordL });

    const stepByDomain = new Map(state.sweep_steps.map((st) => [st.domain, st]));

    // 2. Post-merge accretions on the survivor (selection is the representative
    // operational holder) — listed for triage BEFORE moving rows back.
    const engMoved = new Set(stepByDomain.get('selection')?.repointed_ids ?? []);
    const engOnSurvivor = await this.selection.listIdsByTalentRecord({
      tenant_id,
      talent_record_id: recordS,
    });
    const engAccretions = engOnSurvivor.filter((id) => !engMoved.has(id));
    if (engAccretions.length > 0) accretions.push({ domain: 'selection', ids: engAccretions });

    // 3. Consent: delete the synthetic re-home grants.
    if (stepByDomain.has('consent-ledger')) {
      await this.consent.deleteReconcileGrants({
        tenant_id,
        to_record_id: recordS,
        operation_id: advisory.id,
      });
    }

    // 4. Operational holders: re-point back the recorded ids; restore collisions.
    for (const { domain, repo } of this.operationalHolders()) {
      const step = stepByDomain.get(domain);
      if (step === undefined) continue;
      if (step.repointed_ids.length > 0) {
        await repo.repointTalentRecordRefs({
          tenant_id,
          from_record_id: recordS,
          to_record_id: recordL,
          only_ids: step.repointed_ids,
        });
      }
      const removed = state.collision_records
        .filter((c) => c.domain === domain)
        .map((c) => c.row as Record<string, unknown>);
      if (removed.length > 0) {
        await (repo as CollisionRepoint).restoreRemovedRows(removed);
      }
    }

    // 5. Reversal audit event (appends; never rewrites the re-home event).
    await this.consent.appendRecordReconcileAuditEvent({
      tenant_id,
      from_record_id: recordL,
      to_record_id: recordS,
      operation_id: advisory.id,
      actor_id: input.actor_id,
      event_type: 'consent.record_reconcile_reversed',
    });

    return accretions;
  }
}
