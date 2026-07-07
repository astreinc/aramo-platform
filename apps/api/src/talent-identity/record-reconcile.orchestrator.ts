import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConsentRepository } from '@aramo/consent';
import { PipelineRepository } from '@aramo/pipeline';
import { SubmittalRepository } from '@aramo/submittal';
import { EvidenceRepository } from '@aramo/evidence';
import { EngagementRepository } from '@aramo/engagement';
import { ExaminationRepository } from '@aramo/examination';
import { TalentEvidenceRepository } from '@aramo/talent-evidence';
import { SavedListRepository } from '@aramo/saved-list';
import { AttachmentRepository } from '@aramo/attachment';
import { ActivityRepository } from '@aramo/activity';
import { TaskRepository } from '@aramo/task';
import { TalentRecordRepository } from '@aramo/talent-record';
import {
  TalentTrustRepository,
  TalentTrustService,
  type SubjectMergeOperationRow,
  type SweepStepRecord,
  type CollisionRecord,
} from '@aramo/talent-trust';

// RecordReconcileOrchestrator — TR-2a-B3b (DDR-3 §1/§2/§4/§6). Phase 2 of a
// human-approved merge: the RECORD reconcile. Lives in apps/api (ABOVE the I15
// wall — the PromotionService/advisory-resolution precedent, ratified for this
// slice), composing the cip trust-side reads/writes + each ATS domain's OWN
// re-point method (each schema's writes stay in its owning lib; the orchestrator
// NEVER reaches into a foreign schema — it calls repository methods). No
// cip→ATS import edge is created (talent_trust imports NO ats).
//
// Guarantee (DDR-3 §1): after phase 2, exactly one live record per human in the
// merged cluster; every cross-schema ref re-pointed or accounted for; no evidence
// blended (cluster reads, B3a); reversible from the durable SubjectMergeOperation.
//
// Non-atomic + fail-closed (DDR-3 §4 ordering): (1) subject merge [phase 1, done
// by the caller]; (2) supersession flag + ref normalization; (3) domain sweeps
// (consent FIRST); (4) recompute(survivor); (5) complete. During the window the
// system UNDER-reports only (a not-yet-re-pointed consent → the send-gate blocks a
// send → safe) and NEVER over-reports (a superseded record never surfaces live).
// Every step is idempotent against the operation record → a crash leaves a
// resumable PENDING operation the resume command completes, never a silent half-sweep.

// The uniform operational-holder repoint contract (DDR-3 §4). Every domain repo
// implements this identically; the orchestrator sweeps them in a loop.
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

export interface ReconcileInput {
  tenant_id: string;
  advisory_id: string | null;
  surviving_subject_id: string;
  merged_subject_id: string;
  actor_id: string | null;
}

export interface ReverseInput {
  tenant_id: string;
  operation_id: string;
  actor_id: string;
  justification: string;
}

export interface ReverseResult {
  operation: SubjectMergeOperationRow;
  // Rows created against R_S AFTER the reconcile — NOT auto-redistributed; handed
  // to a human for triage (DDR-3 §6). Shape: [{ domain, ids: string[] }].
  post_merge_accretions: Array<{ domain: string; ids: string[] }>;
}

@Injectable()
export class RecordReconcileOrchestrator {
  private readonly logger = new Logger(RecordReconcileOrchestrator.name);

  constructor(
    private readonly trustRepo: TalentTrustRepository,
    private readonly trust: TalentTrustService,
    private readonly talentRecords: TalentRecordRepository,
    private readonly consent: ConsentRepository,
    private readonly pipeline: PipelineRepository,
    private readonly submittal: SubmittalRepository,
    private readonly evidence: EvidenceRepository,
    private readonly engagement: EngagementRepository,
    private readonly examination: ExaminationRepository,
    private readonly talentEvidence: TalentEvidenceRepository,
    private readonly savedList: SavedListRepository,
    private readonly attachment: AttachmentRepository,
    private readonly activity: ActivityRepository,
    private readonly task: TaskRepository,
  ) {}

  // The operational holders, in sweep order (consent's ledger/audit run FIRST,
  // handled specially before this list). Pipeline + saved-list carry collisions.
  private operationalHolders(): Array<{ domain: string; repo: OperationalRepoint }> {
    return [
      { domain: 'pipeline', repo: this.pipeline as unknown as OperationalRepoint },
      { domain: 'submittal', repo: this.submittal as unknown as OperationalRepoint },
      { domain: 'evidence', repo: this.evidence as unknown as OperationalRepoint },
      { domain: 'engagement', repo: this.engagement as unknown as OperationalRepoint },
      { domain: 'examination', repo: this.examination as unknown as OperationalRepoint },
      { domain: 'talent-evidence', repo: this.talentEvidence as unknown as OperationalRepoint },
      { domain: 'saved-list', repo: this.savedList as unknown as OperationalRepoint },
      { domain: 'attachment', repo: this.attachment as unknown as OperationalRepoint },
      { domain: 'activity', repo: this.activity as unknown as OperationalRepoint },
      { domain: 'task', repo: this.task as unknown as OperationalRepoint },
    ];
  }

  // ---- Phase 2: reconcile (DDR-3 §2 three cases + §4 sweep) -----------------

  async reconcile(input: ReconcileInput): Promise<SubjectMergeOperationRow> {
    const { tenant_id, surviving_subject_id, merged_subject_id } = input;

    // Idempotency: a COMPLETED operation for this exact direction → return it.
    const prior = await this.trustRepo.findMergeOperationBySubjects(
      tenant_id,
      surviving_subject_id,
      merged_subject_id,
    );
    if (prior?.status === 'COMPLETED') return prior;

    const survivorRef = await this.trustRepo.findAtsRecordRef(tenant_id, surviving_subject_id);
    const mergedRef = await this.trustRepo.findAtsRecordRef(tenant_id, merged_subject_id);

    // CASE 1 — neither promoted: no phase 2 (DDR-3 §2). Recompute the survivor's
    // cluster-union trust (B3a) and record a completed no-op operation for audit.
    if (survivorRef === null && mergedRef === null) {
      const op =
        prior ??
        (await this.trustRepo.createMergeOperation({
          ...this.opBase(input),
          surviving_record_id: null,
          superseded_record_id: null,
        }));
      await this.trust.recomputeTrustState(surviving_subject_id, tenant_id);
      return this.trustRepo.completeMergeOperation(op.id, new Date());
    }

    // CASE 2 — one promoted: the single record survives; its ATS ref re-homes to
    // the surviving subject (DDR-3 §2). No cross-schema sweep — the record itself
    // is NOT superseded, so every holder still points at a live record. This closes
    // the double-mint hazard: a later promotion of the survivor sees the cluster's
    // record and no-ops (already_promoted).
    if (survivorRef === null || mergedRef === null) {
      const theRecordId = (survivorRef ?? mergedRef)!.ref_id;
      const op =
        prior ??
        (await this.trustRepo.createMergeOperation({
          ...this.opBase(input),
          surviving_record_id: theRecordId,
          superseded_record_id: null,
        }));
      const refActions = [...op.ref_actions];
      if (mergedRef !== null) {
        // The merged subject carried the record → re-home its ref to the survivor.
        const already = refActions.some(
          (a) => a.ref_id === mergedRef.ref_id && a.kind === 're_homed',
        );
        if (!already) {
          const action = await this.trustRepo.rehomeAtsRecordRef(
            tenant_id,
            mergedRef.ref_id,
            merged_subject_id,
            surviving_subject_id,
          );
          refActions.push(action);
          await this.trustRepo.updateMergeOperation(op.id, { ref_actions: refActions });
        }
      }
      await this.trust.recomputeTrustState(surviving_subject_id, tenant_id);
      return this.trustRepo.completeMergeOperation(op.id, new Date());
    }

    // CASE 3 — BOTH promoted: R_S stays live, R_L is superseded, R_L→R_S swept.
    const recordS = survivorRef.ref_id;
    const recordL = mergedRef.ref_id;
    const op =
      prior ??
      (await this.trustRepo.createMergeOperation({
        ...this.opBase(input),
        surviving_record_id: recordS,
        superseded_record_id: recordL,
      }));

    // Step 2 — supersession flag + ref normalization (linkage copied BEFORE
    // removal, so reversal restores it verbatim). Idempotent.
    await this.talentRecords.supersedeRecord({
      tenant_id,
      id: recordL,
      superseded_by_record_id: recordS,
    });
    const refActions = [...op.ref_actions];
    if (!refActions.some((a) => a.ref_id === mergedRef.ref_id)) {
      const removeAction = await this.trustRepo.removeAtsRecordRef(
        tenant_id,
        mergedRef.ref_id,
        merged_subject_id,
      );
      if (removeAction) refActions.push(removeAction);
    }
    await this.trustRepo.updateMergeOperation(op.id, { ref_actions: refActions });

    // Step 3 — domain sweeps, CONSENT FIRST (DDR-3 §4: consent early → the send-gate
    // becomes survivor-visible ASAP, shrinking the under-report window). Every step
    // idempotent + checkpointed against the operation record.
    const sweepSteps: SweepStepRecord[] = [...op.sweep_steps];
    const collisions: CollisionRecord[] = [...op.collision_records];
    const done = new Set(sweepSteps.map((s) => s.domain));

    if (!done.has('consent-ledger')) {
      const r = await this.consent.repointTalentRecordRefs({
        tenant_id,
        from_record_id: recordL,
        to_record_id: recordS,
        operation_id: op.id,
        actor_id: input.actor_id,
      });
      sweepSteps.push({ domain: 'consent-ledger', status: 'done', repointed_ids: r.repointed_ids, removed_rows: [] });
      await this.trustRepo.updateMergeOperation(op.id, { sweep_steps: sweepSteps });
    }
    if (!done.has('consent-audit')) {
      await this.consent.appendRecordReconcileAuditEvent({
        tenant_id,
        from_record_id: recordL,
        to_record_id: recordS,
        operation_id: op.id,
        actor_id: input.actor_id,
      });
      sweepSteps.push({ domain: 'consent-audit', status: 'done', repointed_ids: [], removed_rows: [] });
      await this.trustRepo.updateMergeOperation(op.id, { sweep_steps: sweepSteps });
    }

    for (const { domain, repo } of this.operationalHolders()) {
      if (done.has(domain)) continue;
      const r = await repo.repointTalentRecordRefs({
        tenant_id,
        from_record_id: recordL,
        to_record_id: recordS,
      });
      sweepSteps.push({ domain, status: 'done', repointed_ids: r.repointed_ids, removed_rows: r.removed_rows });
      for (const row of r.removed_rows) collisions.push({ domain, row });
      await this.trustRepo.updateMergeOperation(op.id, {
        sweep_steps: sweepSteps,
        collision_records: collisions,
      });
    }

    // Step 4 — recompute the survivor's cluster-union trust (B3a).
    await this.trust.recomputeTrustState(surviving_subject_id, tenant_id);

    // Step 5 — complete.
    this.logger.log(
      `record-reconcile complete op=${op.id} survivor_record=${recordS} superseded_record=${recordL} tenant=${tenant_id}`,
    );
    return this.trustRepo.completeMergeOperation(op.id, new Date());
  }

  // Resume a PENDING operation to completion (the CLI/resume command drives this).
  // reconcile() is fully idempotent against the operation record, so resuming is
  // just re-invoking it with the operation's recorded direction.
  async resume(op: SubjectMergeOperationRow): Promise<SubjectMergeOperationRow> {
    if (op.status !== 'PENDING') return op;
    return this.reconcile({
      tenant_id: op.tenant_id,
      advisory_id: op.advisory_id,
      surviving_subject_id: op.surviving_subject_id,
      merged_subject_id: op.merged_subject_id,
      actor_id: null,
    });
  }

  // The resume COMMAND (DDR-3 §4 — tenant-scoped): complete every PENDING operation
  // a crash left behind. Returns the operations it drove to completion.
  async resumeAllPending(tenantId: string): Promise<SubjectMergeOperationRow[]> {
    const pending = await this.trustRepo.findPendingMergeOperations(tenantId);
    const out: SubjectMergeOperationRow[] = [];
    for (const op of pending) {
      out.push(await this.resume(op));
    }
    return out;
  }

  // ---- Detection sweep (DDR-3 §6) — the one-time command --------------------

  // Lists pre-existing two-live-records clusters (both-promoted merged pairs from
  // BEFORE this slice, whose records are both still LIVE) for human-initiated
  // reconcile. Assume the state exists (Q2.1 — silently creatable today); do NOT
  // assume it doesn't. Read-only — reports, acts on nothing.
  async detectTwoLiveRecordClusters(
    tenantId: string,
  ): Promise<
    Array<{
      merged_subject_id: string;
      surviving_subject_id: string;
      merged_record_id: string;
      surviving_record_id: string;
    }>
  > {
    const pairs = await this.trustRepo.findMergedPromotedPairs(tenantId);
    const out: typeof pairs = [];
    for (const p of pairs) {
      // Confirm BOTH records are still live (a since-reconciled pair is not stale).
      const merged = await this.talentRecords.findById({ tenant_id: tenantId, id: p.merged_record_id });
      const surviving = await this.talentRecords.findById({ tenant_id: tenantId, id: p.surviving_record_id });
      if (
        merged !== null &&
        surviving !== null &&
        merged.record_status !== 'superseded' &&
        surviving.record_status !== 'superseded'
      ) {
        out.push(p);
      }
    }
    return out;
  }

  // ---- Reversal (DDR-3 §6) --------------------------------------------------

  async reverse(input: ReverseInput): Promise<ReverseResult> {
    const op = await this.trustRepo.findMergeOperationById(input.tenant_id, input.operation_id);
    if (op === null) {
      throw new NotFoundException(`SubjectMergeOperation ${input.operation_id} not found`);
    }
    if (op.status !== 'COMPLETED') {
      throw new ConflictException(
        `RECONCILE_OPERATION_NOT_REVERSIBLE: operation ${op.id} is ${op.status}, not COMPLETED`,
      );
    }

    // 1. Lift supersession — R_L back to live.
    if (op.superseded_record_id !== null) {
      await this.talentRecords.restoreRecord({ tenant_id: input.tenant_id, id: op.superseded_record_id });
    }

    // 2. Restore ref topology from the record (re-home back / re-create removed ref).
    for (const action of op.ref_actions) {
      await this.trustRepo.restoreRefAction(input.tenant_id, action);
    }

    // 3. Reverse EXACTLY the recorded sweep. For the both-promoted case only (the
    // one-/neither-promoted cases have empty sweeps). Consent: delete the synthetic
    // reconcile grants. Operational: re-point the recorded ids back R_S→R_L, and
    // re-create removed collision rows. Post-merge accretions are enumerated, never
    // moved (DDR-3 §6 — they belong to an ambiguous human by definition).
    const recordS = op.surviving_record_id;
    const recordL = op.superseded_record_id;
    const accretions: Array<{ domain: string; ids: string[] }> = [];

    if (recordS !== null && recordL !== null) {
      const stepByDomain = new Map(op.sweep_steps.map((s) => [s.domain, s]));

      // Enumerate POST-MERGE ACCRETIONS on the survivor BEFORE moving rows back —
      // ids currently on R_S that this operation did NOT move there (engagement is
      // the representative operational holder; the pattern extends per-domain). They
      // belong to an ambiguous human by definition of a false merge → listed for
      // human triage, NEVER auto-redistributed (DDR-3 §6).
      const engStep = stepByDomain.get('engagement');
      const engMoved = new Set(engStep?.repointed_ids ?? []);
      const engOnSurvivor = await this.engagement.listIdsByTalentRecord({
        tenant_id: input.tenant_id,
        talent_record_id: recordS,
      });
      const engAccretions = engOnSurvivor.filter((id) => !engMoved.has(id));
      if (engAccretions.length > 0) accretions.push({ domain: 'engagement', ids: engAccretions });

      if (stepByDomain.has('consent-ledger')) {
        await this.consent.deleteReconcileGrants({
          tenant_id: input.tenant_id,
          to_record_id: recordS,
          operation_id: op.id,
        });
      }

      for (const { domain, repo } of this.operationalHolders()) {
        const step = stepByDomain.get(domain);
        if (step === undefined) continue;
        // Re-point back exactly the rows this operation moved (by recorded id).
        if (step.repointed_ids.length > 0) {
          await repo.repointTalentRecordRefs({
            tenant_id: input.tenant_id,
            from_record_id: recordS,
            to_record_id: recordL,
            only_ids: step.repointed_ids,
          });
        }
        // Re-create any collision rows removed on the forward sweep (verbatim).
        const removed = op.collision_records
          .filter((c) => c.domain === domain)
          .map((c) => c.row as Record<string, unknown>);
        if (removed.length > 0) {
          await (repo as CollisionRepoint).restoreRemovedRows(removed);
        }
      }
    }

    // 4. Reversal audit event (never rewrites the reconcile event — appends its own).
    if (recordS !== null && recordL !== null) {
      await this.consent.appendRecordReconcileAuditEvent({
        tenant_id: input.tenant_id,
        from_record_id: recordL,
        to_record_id: recordS,
        operation_id: op.id,
        actor_id: input.actor_id,
        event_type: 'consent.record_reconcile_reversed',
      });
    }

    // 5. Recompute BOTH subjects — the cluster sets separate cleanly (B3a; no
    // blending ever occurred, so nothing to un-blend).
    await this.trust.recomputeTrustState(op.surviving_subject_id, input.tenant_id);
    await this.trust.recomputeTrustState(op.merged_subject_id, input.tenant_id);

    const reversed = await this.trustRepo.markMergeOperationReversed(op.id, {
      reversed_by: input.actor_id,
      reversed_at: new Date(),
      reversal_justification: input.justification,
      post_merge_accretions: accretions,
    });
    return { operation: reversed, post_merge_accretions: accretions };
  }

  private opBase(input: ReconcileInput): {
    tenant_id: string;
    advisory_id: string | null;
    surviving_subject_id: string;
    merged_subject_id: string;
  } {
    return {
      tenant_id: input.tenant_id,
      advisory_id: input.advisory_id,
      surviving_subject_id: input.surviving_subject_id,
      merged_subject_id: input.merged_subject_id,
    };
  }
}
