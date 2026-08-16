import { Logger } from '@nestjs/common';

import {
  FileArchiveSink,
  serializeArchive,
  checksumArchive,
  type ArchivePayload,
  type ArchiveSink,
} from './archive.js';
import type { PgExec } from './pg-exec.js';
import {
  RESET_REASON,
  type EntityCount,
  type RecordResetBatchInput,
  type ResetResult,
  type RowsByEntity,
} from './reset-batch.js';

// Track-0 (Tenant Reset & Archive, Directive v1.0 LOCKED) — the delete-
// pass engine behind the `tenant-reset` CLI. NO HTTP surface. It
// permanently destroys requisition-domain data for ONE explicitly-
// supplied tenant, after archiving and verifying it, and records an
// append-only ResetBatch. Built and tested against CONTROLLED DATA ONLY;
// merging authorises NOTHING against Astre (§8).
//
// Cross-schema by raw SQL with fully-qualified table names (the
// erase-talent precedent) — no Prisma model import, so this lib crosses
// no nx boundary (scope:boundary; a requisition-domain lib import would
// breach the scope:ats wall).
//
// Execution order is binding (§3): assert tenant · dry-run first · write
// freeze · count before · export · verify archive · verify UsageEvent ·
// delete (§2.2 order) · orphan checks · count after · reset batch ·
// release freeze. Steps 5–7 gate step 8 ABSOLUTELY: no archive, no
// verification, no delete.

// ---------------------------------------------------------------------------
// The recorder the service appends the administrative record through.
// ResetBatchStore satisfies this structurally; unit tests pass a fake so
// the service is exercised without a Prisma connection.
// ---------------------------------------------------------------------------
export interface ResetBatchRecorder {
  record(input: RecordResetBatchInput): Promise<{ id: string }>;
  findCompletedRealRun(tenantId: string): Promise<{ id: string } | null>;
}

// ---------------------------------------------------------------------------
// The deletion inventory — §2.2 order EXACTLY, child-before-parent within
// each step (event children have Restrict FKs; assignments / status
// history cascade but are deleted explicitly for honest counts and to
// honour the directive's stated order). Every row is scoped to the tenant;
// Activity is the ONE scoped-purge (§2.3) — it is NEVER a table-wide
// delete: only requisition/pipeline-subject rows go, talent/company/
// contact history survives.
// ---------------------------------------------------------------------------

/** The Activity scoping predicate (§2.3) — reported verbatim at Gate-6.
 *  $1 = tenant, $2 = requisition ids, $3 = pipeline ids. It matches ONLY
 *  workflow-subject activity; subject_type IN ('talent_record','company',
 *  'contact') and NULL never match, so talent history is preserved. */
export const ACTIVITY_SCOPE_PREDICATE =
  `tenant_id = $1::uuid AND (` +
  `(subject_type = 'requisition' AND subject_id = ANY($2::uuid[])) OR ` +
  `(subject_type = 'pipeline' AND subject_id = ANY($3::uuid[]))` +
  `)`;

interface DeleteStep {
  /** The §2.2 item this belongs to (1..7; 7 = E2 pre-start, T0 v1.1 §2.2.7). */
  readonly item: number;
  readonly label: string; // schema."Table"
  readonly where: string;
  readonly scoping: 'tenant' | 'activity';
}

const DELETE_INVENTORY: readonly DeleteStep[] = [
  // §2.2.1 — Activity (SCOPED purge, never table-wide).
  { item: 1, label: `activity."Activity"`, where: ACTIVITY_SCOPE_PREDICATE, scoping: 'activity' },
  // §2.2.2 — RequisitionLifecycleEvent (bare-UUID history that survives FK
  //          deletion by design → must be explicitly deleted; only after
  //          verified archival export, which the execution order guarantees).
  { item: 2, label: `requisition."RequisitionLifecycleEvent"`, where: `tenant_id = $1::uuid`, scoping: 'tenant' },
  // §2.2.3 — Submittals (event child first — Restrict FK).
  { item: 3, label: `submittal."TalentSubmittalEvent"`, where: `tenant_id = $1::uuid`, scoping: 'tenant' },
  { item: 3, label: `submittal."TalentSubmittalRecord"`, where: `tenant_id = $1::uuid`, scoping: 'tenant' },
  // §2.2.4 — Selection workflow rows (event child first). Physical schema is
  // `selection` post-T2-P2; the frozen /v1/selections wire surface is P3 scope.
  { item: 4, label: `selection."TalentSelectionEvent"`, where: `tenant_id = $1::uuid`, scoping: 'tenant' },
  { item: 4, label: `selection."TalentSelection"`, where: `tenant_id = $1::uuid`, scoping: 'tenant' },
  // §2.2.5 — PipelineStatusHistory, then Pipeline.
  { item: 5, label: `pipeline."PipelineStatusHistory"`, where: `tenant_id = $1::uuid`, scoping: 'tenant' },
  { item: 5, label: `pipeline."Pipeline"`, where: `tenant_id = $1::uuid`, scoping: 'tenant' },
  // §2.2.6 — Requisitions (assignment child first — cascades, deleted explicitly).
  { item: 6, label: `requisition."RequisitionAssignment"`, where: `tenant_id = $1::uuid`, scoping: 'tenant' },
  { item: 6, label: `requisition."Requisition"`, where: `tenant_id = $1::uuid`, scoping: 'tenant' },
  // PR-15 — the internal-number allocator. Must be cleared so the tenant's first
  // recreated requisition restarts at REQ-1000 (PO timing ruling). Without this,
  // the counter survives and the next create silently continues (e.g. REQ-1043).
  { item: 6, label: `requisition."RequisitionNumberSequence"`, where: `tenant_id = $1::uuid`, scoping: 'tenant' },
  // §2.2.7 (T0 v1.1) — E2 pre-start requirement domain, FK-safe order:
  // Audit (child of Instance) → Instance → Definition (child of Set) →
  // MaterializationIntent (no FK) → Set. Audit + Instance carry BEFORE DELETE
  // reject triggers with an exact-value `app.tenant_reset` escape; the reset
  // sets that marker before this loop. Definition/Intent/Set have no delete
  // trigger and delete ordinarily. All are archived + verified + counted through
  // the same DELETE_INVENTORY machinery.
  { item: 7, label: `pre_start_requirement."PreStartRequirementAudit"`, where: `tenant_id = $1::uuid`, scoping: 'tenant' },
  { item: 7, label: `pre_start_requirement."PreStartRequirementInstance"`, where: `tenant_id = $1::uuid`, scoping: 'tenant' },
  { item: 7, label: `pre_start_requirement."PreStartRequirementDefinition"`, where: `tenant_id = $1::uuid`, scoping: 'tenant' },
  { item: 7, label: `pre_start_requirement."PreStartMaterializationIntent"`, where: `tenant_id = $1::uuid`, scoping: 'tenant' },
  { item: 7, label: `pre_start_requirement."PreStartRequirementSet"`, where: `tenant_id = $1::uuid`, scoping: 'tenant' },
  // §2.2.8 (PR-C, PO Ruling 14-b) — the complete placement aggregate (Track 3),
  // FK-safe + trigger-aware order: OutboxEvent → PlacementProcessEvent →
  // PlacementProcess. PlacementProcessEvent has a Restrict FK to PlacementProcess,
  // so it MUST precede the parent (omitting it fails the parent delete, not just a
  // partial reset). OutboxEvent and PlacementProcessEvent carry BEFORE DELETE
  // reject triggers with the exact-value `app.tenant_reset` escape added by
  // migration 20260806090000_placement_tenant_reset_escape; the reset sets that
  // marker before this loop. PlacementProcess has no delete trigger and deletes
  // ordinarily once its event child is gone. Placement events are tenant-owned and
  // NOT in the PRESERVE set (Ruling 14-b): append-only means immutable during
  // ordinary use, not survival of a separately governed destructive reset.
  { item: 8, label: `placement."OutboxEvent"`, where: `tenant_id = $1::uuid`, scoping: 'tenant' },
  { item: 8, label: `placement."PlacementProcessEvent"`, where: `tenant_id = $1::uuid`, scoping: 'tenant' },
  // Track 4 / T4-F — ContractAssignment (authoritative post-start commitment), a NEW
  // tenant-owned placement table. NO FK to PlacementProcess (plain scalar §7.3) and
  // NO delete-reject trigger → NO escape migration needed; deletes ordinarily.
  // Positioned child-before-parent (logical child of PlacementProcess).
  // Track 5 / T5-P1 — AssignmentRateVersion (initial actual commercial terms), a NEW
  // tenant-owned placement table. Append-only WITH a delete-reject trigger carrying
  // the exact-value `app.tenant_reset` escape (migration 20260810130000), so it
  // deletes ONLY inside this governed reset. Positioned child-before-parent (logical
  // child of ContractAssignment).
  { item: 8, label: `placement."AssignmentRateVersion"`, where: `tenant_id = $1::uuid`, scoping: 'tenant' },
  { item: 8, label: `placement."ContractAssignment"`, where: `tenant_id = $1::uuid`, scoping: 'tenant' },
  { item: 8, label: `placement."PlacementProcess"`, where: `tenant_id = $1::uuid`, scoping: 'tenant' },
];

// The freeze (§3.3): the requisition-domain workflow tables, locked ACCESS
// EXCLUSIVE for the reset transaction. Activity is deliberately NOT locked
// — talent/company/contact activity must stay writable; workflow activity
// writes ride the (locked) pipeline/selection transactions and so cannot
// commit mid-reset anyway. The lock releases automatically at COMMIT /
// ROLLBACK — touching no preserved entity, unlike a tenant-status toggle.
const LOCK_TABLES: readonly string[] = [
  `requisition."Requisition"`,
  `requisition."RequisitionAssignment"`,
  `requisition."RequisitionLifecycleEvent"`,
  // PR-15 — freeze the allocator too, so no concurrent create re-seeds the
  // counter row mid-reset (it is deleted in the same transaction).
  `requisition."RequisitionNumberSequence"`,
  `pipeline."Pipeline"`,
  `pipeline."PipelineStatusHistory"`,
  `selection."TalentSelection"`,
  `selection."TalentSelectionEvent"`,
  `submittal."TalentSubmittalRecord"`,
  `submittal."TalentSubmittalEvent"`,
  // §2.2.7 (T0 v1.1) — freeze the E2 pre-start tables for the reset transaction.
  `pre_start_requirement."PreStartRequirementAudit"`,
  `pre_start_requirement."PreStartRequirementInstance"`,
  `pre_start_requirement."PreStartRequirementDefinition"`,
  `pre_start_requirement."PreStartMaterializationIntent"`,
  `pre_start_requirement."PreStartRequirementSet"`,
  // §2.2.8 (PR-C) — freeze the complete placement aggregate for the reset
  // transaction (all three tables are deleted in the same transaction).
  `placement."OutboxEvent"`,
  `placement."PlacementProcessEvent"`,
  `placement."AssignmentRateVersion"`,
  `placement."ContractAssignment"`,
  `placement."PlacementProcess"`,
];

// The PRESERVE set (§2.2) — untouched, and verified untouched after. Every
// count here must be identical before and after (§6). `activity (non-
// workflow)` is the talent/company/contact history that a scoped Activity
// purge must leave intact.
interface PreserveStep {
  readonly label: string;
  readonly display: string;
  readonly where: string; // uses $1 = tenant
}
const PRESERVE_INVENTORY: readonly PreserveStep[] = [
  { label: `metering."UsageEvent"`, display: `metering."UsageEvent"`, where: `tenant_id = $1::uuid` },
  { label: `consent."TalentConsentEvent"`, display: `consent."TalentConsentEvent"`, where: `tenant_id = $1::uuid` },
  { label: `talent_record."TalentRecord"`, display: `talent_record."TalentRecord"`, where: `tenant_id = $1::uuid` },
  { label: `company."Company"`, display: `company."Company"`, where: `tenant_id = $1::uuid` },
  { label: `contact."Contact"`, display: `contact."Contact"`, where: `tenant_id = $1::uuid` },
  { label: `identity."Tenant"`, display: `identity."Tenant"`, where: `id = $1::uuid` },
  {
    label: `activity."Activity" (non-workflow)`,
    display: `activity."Activity" (talent/company/contact history)`,
    where: `tenant_id = $1::uuid AND (subject_type IS NULL OR subject_type NOT IN ('requisition','pipeline'))`,
  },
];

// The snapshot fields §2.3 says a stand-alone UsageEvent "carries". On the
// live substrate metering.UsageEvent has none of them (only id, tenant_id,
// event_type, quantity, occurred_at) — a reportable DIVERGENCE. It also has
// NO FK and NO requisition/pipeline reference, so no retained UsageEvent can
// be stranded by these deletes; the §2.3 HALT condition ("would become
// unexplainable") therefore cannot fire on this substrate.
const USAGE_SNAPSHOT_FIELDS = [
  'actor',
  'channel',
  'billing_key',
  'requisition_id',
  'pipeline_id',
  'correlation_id',
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantAssertionError extends Error {
  override readonly name = 'TenantAssertionError';
}
export class RerunRefusedError extends Error {
  override readonly name = 'RerunRefusedError';
}
export class ArchiveLocationRequiredError extends Error {
  override readonly name = 'ArchiveLocationRequiredError';
}

export interface ResetScope {
  readonly requisition_ids: string[];
  readonly pipeline_ids: string[];
}

export interface EntityCountReport {
  readonly label: string;
  readonly before: number;
  readonly after: number | null;
}

export interface UsageEventCheck {
  readonly retained_count: number;
  readonly dangling_refs: number;
  readonly missing_snapshot_fields: string[];
  readonly explainable: boolean;
}

export interface OrphanCheck {
  readonly label: string;
  readonly remaining: number;
}

export interface ResetReport {
  readonly tenant_id: string;
  readonly mode: 'dry-run' | 'execute';
  readonly reason: string;
  readonly approved_by: string;
  readonly execution_commit: string;
  readonly scope: ResetScope;
  readonly activity_predicate: string;
  readonly deleted: EntityCountReport[];
  readonly preserved: EntityCountReport[];
  readonly archive_location: string | null;
  readonly archive_checksum: string | null;
  readonly archive_verified: boolean;
  readonly usage_event_check: UsageEventCheck;
  readonly orphan_checks: OrphanCheck[];
  readonly freeze_engaged: boolean;
  readonly freeze_released: boolean;
  readonly result: ResetResult;
  readonly batch_id: string | null;
  readonly notes: string[];
}

export interface ResetOptions {
  readonly tenantId: string;
  /** The human who authorised — NOT the executing process (§4). */
  readonly approvedBy: string;
  /** The SHA the tool ran at (§2.1) — supplied at run time. */
  readonly executionCommit: string;
  /** Where the immutable archive is written (real run only). */
  readonly archiveLocation?: string;
  /** Override the re-run refusal with a new approval (§4). */
  readonly overrideCompletedRun?: boolean;
  /** A clock, injectable for deterministic tests. Defaults to Date. */
  readonly now?: () => Date;
}

export class TenantResetService {
  private readonly logger = new Logger(TenantResetService.name);

  constructor(
    private readonly recorder: ResetBatchRecorder,
    private readonly archive: ArchiveSink = new FileArchiveSink(),
  ) {}

  // ---- shared helpers ----------------------------------------------------

  /** §3.1 / §4 — the tenant id is explicit, well-formed, and real. A wrong
   *  tenant id refuses with NO partial work (§6). Never inferred/defaulted. */
  private async assertTenant(pg: PgExec, tenantId: string): Promise<void> {
    if (tenantId === undefined || tenantId === null || tenantId.trim().length === 0) {
      throw new TenantAssertionError('tenant id is required and must be supplied explicitly');
    }
    if (!UUID_RE.test(tenantId)) {
      throw new TenantAssertionError(`tenant id is not a well-formed uuid: ${tenantId}`);
    }
    const rows = await pg.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM identity."Tenant" WHERE id = $1::uuid`,
      [tenantId],
    );
    if (Number(rows.rows[0]?.n ?? 0) === 0) {
      throw new TenantAssertionError(`no such tenant: ${tenantId} — refusing (no partial work)`);
    }
  }

  private async resolveScope(pg: PgExec, tenantId: string): Promise<ResetScope> {
    const reqRows = await pg.query<{ id: string }>(
      `SELECT id FROM requisition."Requisition" WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    const pipeRows = await pg.query<{ id: string }>(
      `SELECT id FROM pipeline."Pipeline" WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    return {
      requisition_ids: reqRows.rows.map((r) => r.id),
      pipeline_ids: pipeRows.rows.map((r) => r.id),
    };
  }

  private stepParams(step: DeleteStep, tenantId: string, scope: ResetScope): unknown[] {
    return step.scoping === 'activity'
      ? [tenantId, scope.requisition_ids, scope.pipeline_ids]
      : [tenantId];
  }

  private async countDeleted(
    pg: PgExec,
    tenantId: string,
    scope: ResetScope,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const step of DELETE_INVENTORY) {
      const r = await pg.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM ${step.label} WHERE ${step.where}`,
        this.stepParams(step, tenantId, scope),
      );
      out.set(step.label, Number(r.rows[0]?.n ?? 0));
    }
    return out;
  }

  private async countPreserved(pg: PgExec, tenantId: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const step of PRESERVE_INVENTORY) {
      const r = await pg.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM ${step.label.replace(/ \(non-workflow\)$/, '')} WHERE ${step.where}`,
        [tenantId],
      );
      out.set(step.display, Number(r.rows[0]?.n ?? 0));
    }
    return out;
  }

  /** §2.3 / §3.7 — every retained UsageEvent must stand alone (no required
   *  FK to a deleted row; no dangling requisition/pipeline reference that
   *  would render it unexplainable). Reports which enumerated snapshot
   *  fields the substrate lacks (a divergence) but only refuses if a
   *  retained row would actually be stranded. */
  private async checkUsageEvents(
    pg: PgExec,
    tenantId: string,
    scope: ResetScope,
  ): Promise<UsageEventCheck> {
    const retained = await pg.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM metering."UsageEvent" WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    const cols = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'metering' AND table_name = 'UsageEvent'`,
    );
    const present = new Set(cols.rows.map((r) => r.column_name));
    const missing = USAGE_SNAPSHOT_FIELDS.filter((f) => !present.has(f));

    // If a ref column DOES exist, count rows whose ref points at a row we are
    // about to delete — those would be stranded (unexplainable) → HALT.
    let dangling = 0;
    if (present.has('requisition_id') && scope.requisition_ids.length > 0) {
      const r = await pg.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM metering."UsageEvent"
          WHERE tenant_id = $1::uuid AND requisition_id = ANY($2::uuid[])`,
        [tenantId, scope.requisition_ids],
      );
      dangling += Number(r.rows[0]?.n ?? 0);
    }
    if (present.has('pipeline_id') && scope.pipeline_ids.length > 0) {
      const r = await pg.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM metering."UsageEvent"
          WHERE tenant_id = $1::uuid AND pipeline_id = ANY($2::uuid[])`,
        [tenantId, scope.pipeline_ids],
      );
      dangling += Number(r.rows[0]?.n ?? 0);
    }
    return {
      retained_count: Number(retained.rows[0]?.n ?? 0),
      dangling_refs: dangling,
      missing_snapshot_fields: missing,
      // A dangling ref is only fatal if the substrate carries a hard FK; on
      // this substrate the refs are UUID-only (dangle allowed by §2.3). We
      // treat presence-of-ref-column + pointing-at-a-deleted-row as the
      // signal to HALT, honouring §2.3's "would become unexplainable".
      explainable: dangling === 0,
    };
  }

  private async buildArchivePayload(
    pg: PgExec,
    opts: ResetOptions,
    scope: ResetScope,
  ): Promise<ArchivePayload> {
    const entities: Record<string, Array<Record<string, unknown>>> = {};
    for (const step of DELETE_INVENTORY) {
      const rows = await pg.query<Record<string, unknown>>(
        `SELECT * FROM ${step.label} WHERE ${step.where}`,
        this.stepParams(step, opts.tenantId, scope),
      );
      entities[step.label] = rows.rows;
    }
    return {
      tenant_id: opts.tenantId,
      reason: RESET_REASON,
      execution_commit: opts.executionCommit,
      entities,
    };
  }

  private toEntityReports(
    before: Map<string, number>,
    after: Map<string, number> | null,
  ): EntityCountReport[] {
    return [...before.keys()].map((label) => ({
      label,
      before: before.get(label) ?? 0,
      after: after === null ? null : (after.get(label) ?? 0),
    }));
  }

  private rowsByEntity(
    deletedBefore: Map<string, number>,
    deletedAfter: Map<string, number> | null,
    preservedBefore: Map<string, number>,
    preservedAfter: Map<string, number> | null,
  ): RowsByEntity {
    const toRec = (
      b: Map<string, number>,
      a: Map<string, number> | null,
    ): Record<string, EntityCount> => {
      const out: Record<string, EntityCount> = {};
      for (const label of b.keys()) {
        out[label] = { before: b.get(label) ?? 0, after: a === null ? null : (a.get(label) ?? 0) };
      }
      return out;
    };
    return { deleted: toRec(deletedBefore, deletedAfter), preserved: toRec(preservedBefore, preservedAfter) };
  }

  // ---- dry run (§3.2) — full plan, all counts, ZERO mutations ------------

  async dryRun(pg: PgExec, opts: ResetOptions): Promise<ResetReport> {
    const now = opts.now ?? (() => new Date());
    const startedAt = now();
    await this.assertTenant(pg, opts.tenantId); // §3.1

    const scope = await this.resolveScope(pg, opts.tenantId);
    const deletedBefore = await this.countDeleted(pg, opts.tenantId, scope); // §3.4 (counts only)
    const preservedBefore = await this.countPreserved(pg, opts.tenantId);
    const usageCheck = await this.checkUsageEvents(pg, opts.tenantId, scope);

    // Build the archive preview in memory (read-only — NO write, NO delete)
    // so the dry run can report the checksum a real run WOULD produce.
    const payload = await this.buildArchivePayload(pg, opts, scope);
    const previewChecksum = checksumArchive(serializeArchive(payload));

    const rowsByEntity = this.rowsByEntity(deletedBefore, null, preservedBefore, null);
    const batch = await this.recorder.record({
      tenant_id: opts.tenantId,
      reason: RESET_REASON,
      approved_by: opts.approvedBy,
      started_at: startedAt,
      completed_at: now(),
      archive_location: null, // dry run writes no archive (§3.2 ZERO mutations)
      archive_checksum: previewChecksum,
      rows_by_entity: rowsByEntity,
      execution_commit: opts.executionCommit,
      dry_run: true,
      result: 'COMPLETED',
    });

    return {
      tenant_id: opts.tenantId,
      mode: 'dry-run',
      reason: RESET_REASON,
      approved_by: opts.approvedBy,
      execution_commit: opts.executionCommit,
      scope,
      activity_predicate: ACTIVITY_SCOPE_PREDICATE,
      deleted: this.toEntityReports(deletedBefore, null),
      preserved: this.toEntityReports(preservedBefore, null),
      archive_location: null,
      archive_checksum: previewChecksum,
      archive_verified: false,
      usage_event_check: usageCheck,
      orphan_checks: [],
      freeze_engaged: false,
      freeze_released: false,
      result: 'COMPLETED',
      batch_id: batch.id,
      notes: this.rollbackNotes('dry-run'),
    };
  }

  // ---- execute (§3.3–§3.12) — the real run -------------------------------

  async execute(pg: PgExec, opts: ResetOptions): Promise<ResetReport> {
    const now = opts.now ?? (() => new Date());
    const startedAt = now();
    await this.assertTenant(pg, opts.tenantId); // §3.1

    // §4 — RE-RUN IS REFUSED, NOT REPEATED. A completed real run blocks
    // another until explicitly overridden with a new approval.
    if (opts.overrideCompletedRun !== true) {
      const prior = await this.recorder.findCompletedRealRun(opts.tenantId);
      if (prior !== null) {
        throw new RerunRefusedError(
          `tenant ${opts.tenantId} already has a completed reset (batch ${prior.id}). ` +
            `Re-run is refused, not repeated (§4). Supply an explicit override + new approval to proceed.`,
        );
      }
    }

    const archiveLocation = opts.archiveLocation;
    if (archiveLocation === undefined || archiveLocation.trim().length === 0) {
      throw new ArchiveLocationRequiredError(
        'a real run requires an explicit archive location — no delete without a verified archive (§3.5–3.6)',
      );
    }

    const scope = await this.resolveScope(pg, opts.tenantId);

    let frozen = false;
    let released = false;
    let archiveChecksum: string | null = null;
    let archiveVerified = false;
    let deletedBefore = new Map<string, number>();
    let preservedBefore = new Map<string, number>();
    let usageCheck: UsageEventCheck = {
      retained_count: 0,
      dangling_refs: 0,
      missing_snapshot_fields: [],
      explainable: true,
    };

    const abort = async (
      result: ResetResult,
      note: string,
    ): Promise<ResetReport> => {
      if (frozen && !released) {
        await pg.query('ROLLBACK');
        released = true;
      }
      const batch = await this.recorder.record({
        tenant_id: opts.tenantId,
        reason: RESET_REASON,
        approved_by: opts.approvedBy,
        started_at: startedAt,
        completed_at: now(),
        archive_location: result === 'ABORTED' ? archiveLocation : null,
        archive_checksum: archiveChecksum,
        rows_by_entity: this.rowsByEntity(deletedBefore, null, preservedBefore, null),
        execution_commit: opts.executionCommit,
        dry_run: false,
        result,
      });
      this.logger.warn(`tenant-reset ${result}: ${note}`);
      return {
        tenant_id: opts.tenantId,
        mode: 'execute',
        reason: RESET_REASON,
        approved_by: opts.approvedBy,
        execution_commit: opts.executionCommit,
        scope,
        activity_predicate: ACTIVITY_SCOPE_PREDICATE,
        deleted: this.toEntityReports(deletedBefore, null),
        preserved: this.toEntityReports(preservedBefore, null),
        archive_location: result === 'ABORTED' ? archiveLocation : null,
        archive_checksum: archiveChecksum,
        archive_verified: archiveVerified,
        usage_event_check: usageCheck,
        orphan_checks: [],
        freeze_engaged: frozen,
        freeze_released: released,
        result,
        batch_id: batch.id,
        notes: [note, ...this.rollbackNotes('execute')],
      };
    };

    try {
      // §3.3 WRITE FREEZE — one transaction; lock the workflow tables.
      await pg.query('BEGIN');
      await pg.query(`LOCK TABLE ${LOCK_TABLES.join(', ')} IN ACCESS EXCLUSIVE MODE`);
      frozen = true;

      // T0 v1.1 §2.4 — authorise the E2 protected DELETEs (Instance + Audit carry
      // BEFORE DELETE reject triggers with an exact-value escape). SET LOCAL only,
      // on THIS reset connection, inside THIS transaction, cleared automatically at
      // COMMIT / ROLLBACK. Set here — after the freeze, before any DELETE. Dry-run
      // never reaches this path and never sets the marker (canonical T0 §3:
      // "DRY RUN = ZERO mutations"; ARCHITECTURE_HALT resolved in favour of T0).
      await pg.query(`SET LOCAL app.tenant_reset = 'authorized'`);

      // §3.4 COUNT BEFORE.
      deletedBefore = await this.countDeleted(pg, opts.tenantId, scope);
      preservedBefore = await this.countPreserved(pg, opts.tenantId);

      // §3.5 EXPORT — the immutable archive of everything to be deleted.
      const payload = await this.buildArchivePayload(pg, opts, scope);
      const bytes = serializeArchive(payload);
      archiveChecksum = checksumArchive(bytes);
      await this.archive.write(archiveLocation, bytes);

      // §3.6 VERIFY ARCHIVE — checksum + per-entity row counts match §3.4.
      // MISMATCH = ABORT, no deletes.
      const readBack = await this.archive.read(archiveLocation);
      const reChecksum = checksumArchive(readBack);
      const reParsed = JSON.parse(readBack) as ArchivePayload;
      const countsMatch = DELETE_INVENTORY.every(
        (s) => (reParsed.entities?.[s.label]?.length ?? -1) === (deletedBefore.get(s.label) ?? 0),
      );
      archiveVerified = reChecksum === archiveChecksum && countsMatch;
      if (!archiveVerified) {
        return await abort(
          'ABORTED',
          `archive verification failed (checksum ${reChecksum === archiveChecksum ? 'ok' : 'MISMATCH'}, ` +
            `counts ${countsMatch ? 'ok' : 'MISMATCH'}) — no deletes ran`,
        );
      }

      // §3.7 VERIFY UsageEvent — every retained row explainable standalone.
      usageCheck = await this.checkUsageEvents(pg, opts.tenantId, scope);
      if (!usageCheck.explainable) {
        return await abort(
          'ABORTED',
          `retained UsageEvent(s) would be stranded (${usageCheck.dangling_refs} dangling ref[s]) — no deletes ran`,
        );
      }

      // §3.8 DELETE — §2.2 order exactly.
      const deletedAfter = new Map<string, number>();
      for (const step of DELETE_INVENTORY) {
        await pg.query(
          `DELETE FROM ${step.label} WHERE ${step.where}`,
          this.stepParams(step, opts.tenantId, scope),
        );
        deletedAfter.set(step.label, 0);
      }

      // §3.9 ORPHAN CHECKS + §3.10 COUNT AFTER (still inside the txn — the
      // freeze holds, so these are the authoritative post-delete counts).
      const deletedRecount = await this.countDeleted(pg, opts.tenantId, scope);
      const preservedAfter = await this.countPreserved(pg, opts.tenantId);
      const usageAfter = await this.checkUsageEvents(pg, opts.tenantId, scope);

      const orphanChecks: OrphanCheck[] = DELETE_INVENTORY.map((s) => ({
        label: s.label,
        remaining: deletedRecount.get(s.label) ?? 0,
      }));
      orphanChecks.push({ label: `metering."UsageEvent" dangling`, remaining: usageAfter.dangling_refs });

      const deletedAllZero = orphanChecks.every((o) => o.remaining === 0);
      const preservedUnchanged = PRESERVE_INVENTORY.every(
        (s) => (preservedBefore.get(s.display) ?? 0) === (preservedAfter.get(s.display) ?? 0),
      );

      if (!deletedAllZero || !preservedUnchanged) {
        // An integrity violation — never commit a reset that left orphans or
        // touched a preserved entity.
        return await abort(
          'FAILED',
          `post-delete integrity violation (deleted-all-zero=${deletedAllZero}, ` +
            `preserved-unchanged=${preservedUnchanged}) — rolled back, NO data destroyed`,
        );
      }

      // §3.12 RELEASE FREEZE — commit the whole reset atomically.
      await pg.query('COMMIT');
      released = true;

      // §3.11 RESET BATCH — record the completed run (append-only). Recorded
      // AFTER commit on a separate connection so the audit survives even if a
      // later step fails; the archive file is the durable evidence either way.
      const completedAt = now();
      const rowsByEntity = this.rowsByEntity(deletedBefore, deletedAfter, preservedBefore, preservedAfter);
      const batch = await this.recorder.record({
        tenant_id: opts.tenantId,
        reason: RESET_REASON,
        approved_by: opts.approvedBy,
        started_at: startedAt,
        completed_at: completedAt,
        archive_location: archiveLocation,
        archive_checksum: archiveChecksum,
        rows_by_entity: rowsByEntity,
        execution_commit: opts.executionCommit,
        dry_run: false,
        result: 'COMPLETED',
      });

      return {
        tenant_id: opts.tenantId,
        mode: 'execute',
        reason: RESET_REASON,
        approved_by: opts.approvedBy,
        execution_commit: opts.executionCommit,
        scope,
        activity_predicate: ACTIVITY_SCOPE_PREDICATE,
        deleted: this.toEntityReports(deletedBefore, deletedAfter),
        preserved: this.toEntityReports(preservedBefore, preservedAfter),
        archive_location: archiveLocation,
        archive_checksum: archiveChecksum,
        archive_verified: true,
        usage_event_check: usageAfter,
        orphan_checks: orphanChecks,
        freeze_engaged: true,
        freeze_released: true,
        result: 'COMPLETED',
        batch_id: batch.id,
        notes: this.rollbackNotes('execute'),
      };
    } catch (err) {
      // Any error inside the frozen window: roll back (nothing destroyed),
      // record FAILED, and rethrow so the CLI exits non-zero.
      const note = `unexpected error: ${err instanceof Error ? err.message : String(err)}`;
      await abort('FAILED', note);
      throw err;
    }
  }

  /** §4 / §6 — the guarantees stated in the tool's own output. */
  private rollbackNotes(mode: 'dry-run' | 'execute'): string[] {
    const notes = [
      'ROLLBACK IS ARCHIVE RESTORATION: there is no undo. Once the write freeze lifts and ' +
        'recruiters create data, the archive is history, not a restore point (§4).',
    ];
    if (mode === 'execute') {
      notes.push(
        'Coherence: steps 3–10 run in ONE transaction under an ACCESS EXCLUSIVE freeze. An ' +
          'interruption before COMMIT rolls the whole reset back — the DB is unchanged and the ' +
          'run is safely repeatable. After COMMIT the deletes are durable; a crash between COMMIT ' +
          'and the ResetBatch append leaves the archive file as the record and a re-run finds ' +
          'nothing to delete (idempotent).',
      );
    }
    return notes;
  }
}
