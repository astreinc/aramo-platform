import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { insertActivityInTx } from '@aramo/activity';
import { recordUsage } from '@aramo/metering';

import type { PipelineView } from './dto/pipeline.view.js';
import type { PipelineStatusHistoryView } from './dto/pipeline-status-history.view.js';
import type { CreatePipelineRequestDto } from './dto/create-pipeline-request.dto.js';
import {
  canTransition,
  ACTIVE_FLOW_STAGES,
  activeStageOrdinal,
  type PipelineStatus,
} from './pipeline-state.js';
import { PrismaService } from './prisma/prisma.service.js';

// Segment 3 — the current-stage read-model shape (most-advanced ACTIVE
// membership + which req). `null` from the accessor = the talent is in no
// active pipeline ("none" at the response layer).
export interface CurrentStage {
  readonly stage: PipelineStatus;
  readonly requisition_id: string;
}

// PipelineRepository — write + read surface for Pipeline + the ENFORCED
// state machine transition (PR-A5a Gate 5; PR-A5b-1 extends the placement
// path with the openings_available decrement + over-capacity guard).
//
// === The transition method (PR-A5a directive §3 + PR-A5b-1 §2-3) ===
//
// The five-step internal flow of `transition(...)`:
//   1. Read the current Pipeline.status from the DB (tenant-scoped).
//   2. No-op guard: `to_status === current` → return without DB write.
//      No PipelineStatusHistory row, no Activity row, no metering event.
//      (Directive §2 / Ruling 1: a no-op is a real "same state" semantic;
//      we do NOT pad history with self-loops.)
//   3. Legality check: `canTransition(current, to)` per the application-
//      layer state machine (libs/pipeline/src/lib/pipeline-state.ts).
//      Illegal → throw INVALID_PIPELINE_TRANSITION (422). No write.
//   4. Atomic interactive `$transaction(async tx => ...)` — same-tx
//      atomicity (Ruling 6) across:
//        a. UPDATE Pipeline.status
//        b. INSERT PipelineStatusHistory (from / to / changed_by / note)
//        c. INSERT activity."Activity" (type=pipeline_status_change)
//           via insertActivityInTx — cross-schema $executeRaw composed
//           into the same tx (the recordUsage pattern, second application).
//        d. recordUsage(tx, { event_type: 'pipeline.state_transition' })
//           — the first ATS-domain metered event (Ruling 4; the A1c
//           transactional guarantee, extended to pipeline).
//        e. (PR-A5b-1, ONLY when to === 'placed') cross-schema UPDATE
//           requisition."Requisition" SET openings_available =
//           openings_available - 1 WHERE id = <pipeline.requisition_id>
//           AND tenant_id = <tenant> AND openings_available > 0. The
//           `openings_available > 0` predicate is the OPTIMISTIC over-
//           capacity guard: if the slot is gone (row count == 0), throw
//           REQUISITION_NO_OPENINGS (409) — the throw rolls back the
//           entire interactive tx, so (a)-(d) revert with (e). The Lead-
//           reviewed ruling (refuse the placement rather than silently
//           floor to 0 or allow a negative) is enforced here.
//      All writes commit together, or none does. The integration spec
//      asserts this structurally.
//   5. Return the updated PipelineView (the controller projects it).
//
// === Why interactive form (vs A5a's array form) ===
//
// A5a used the array-form `$transaction([...])` because every leg was a
// stateless PrismaPromise. A5b-1's over-capacity guard needs to inspect
// the row count returned by the decrement UPDATE and throw conditionally
// — the array form cannot do that mid-array. The interactive form
// preserves the SAME-tx atomicity (per the existing recordUsage / insert
// ActivityInTx contract — they both accept any object with $executeRaw,
// which the interactive `tx` parameter satisfies) while allowing the
// conditional throw. Non-placement transitions traverse the same code
// path; the decrement leg is gated on `to === 'placed'`.
//
// === PR-A5b boundary (PR-A5b-1 scope, A5b-2 deferred) ===
//
// A5b-1 writes ONLY requisition.Requisition.openings_available; NO Core
// table (talent.*, examination.*, submittal.*, job_domain.*) is read or
// written. The TalentRecord link is A5b-2 (a separate, later PR). The
// integration spec asserts this structurally: pre/post-placement,
// talent + examination + submittal + job_domain row counts are bit-
// identical; the only delta is requisition.openings_available - 1.
//
// === Delete-restore (PR-A5b-1 §4) ===
//
// Pipeline `placed` is a terminal state (no outgoing transitions per the
// pipeline-state map). Re-entry of a placement on a re-opened requisition
// is delete+recreate. So deleting a `placed`-status pipeline must restore
// the slot it consumed — `delete()` reads the existing row's status
// first; if `placed`, the delete + cross-schema +1 restore commit in a
// single interactive tx. Deleting a non-placed pipeline is the A5a
// behavior verbatim (it never decremented; nothing to restore). The
// restore is unbounded (no upper-bound cap against `openings`): the
// symmetric inverse of the decrement, on the assumption that
// `openings_available` was at most `openings - 1` immediately after the
// placement that decremented.

interface PipelineRow {
  id: string;
  tenant_id: string;
  site_id: string | null;
  talent_record_id: string;
  requisition_id: string;
  status: PipelineStatus;
  created_at: Date;
  updated_at: Date;
}

interface PipelineStatusHistoryRow {
  id: string;
  tenant_id: string;
  pipeline_id: string;
  status_from: PipelineStatus;
  status_to: PipelineStatus;
  changed_by_id: string | null;
  changed_at: Date;
  note: string | null;
}

function projectView(row: PipelineRow): PipelineView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    site_id: row.site_id,
    talent_record_id: row.talent_record_id,
    requisition_id: row.requisition_id,
    status: row.status,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function projectHistoryView(
  row: PipelineStatusHistoryRow,
): PipelineStatusHistoryView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    pipeline_id: row.pipeline_id,
    status_from: row.status_from,
    status_to: row.status_to,
    changed_by_id: row.changed_by_id,
    changed_at: row.changed_at.toISOString(),
    note: row.note,
  };
}

@Injectable()
export class PipelineRepository {
  private readonly logger = new Logger(PipelineRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Write path — create at no_contact
  // -------------------------------------------------------------------------

  async create(args: {
    tenant_id: string;
    input: CreatePipelineRequestDto;
  }): Promise<PipelineView> {
    // Initial state hard-coded to `no_contact` per directive §2 /
    // state-machine proof initial-state invariant. Body cannot override.
    const row = await this.prisma.pipeline.create({
      data: {
        tenant_id: args.tenant_id,
        site_id: args.input.site_id ?? null,
        talent_record_id: args.input.talent_record_id,
        requisition_id: args.input.requisition_id,
        status: 'no_contact',
      },
    });
    return projectView(row as PipelineRow);
  }

  async delete(args: {
    tenant_id: string;
    id: string;
    requestId: string;
  }): Promise<void> {
    // Read the row first to learn its status — the delete-restore branch
    // (PR-A5b-1 §4) needs to know whether this pipeline ever consumed an
    // openings slot. A `placed`-status row consumed one at the
    // transition; deleting it must give the slot back.
    const existing = await this.prisma.pipeline.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
      select: { id: true, status: true, requisition_id: true },
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Pipeline not found in tenant',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }
    // Intra-schema FK on PipelineStatusHistory uses ON DELETE CASCADE,
    // so history rows fall away with the parent (matches the
    // RequisitionAssignment precedent at A3).
    if (existing.status === 'placed') {
      // PR-A5b-1 §4 — delete-restore. Atomic interactive tx so the
      // pipeline delete and the cross-schema openings_available += 1
      // commit together. If either step fails, neither lands.
      await this.prisma.$transaction(async (tx) => {
        await tx.pipeline.delete({ where: { id: args.id } });
        await tx.$executeRaw`
          UPDATE requisition."Requisition"
          SET openings_available = openings_available + 1
          WHERE id = ${existing.requisition_id}::uuid
            AND tenant_id = ${args.tenant_id}::uuid
        `;
      });
      this.logger.log({
        event: 'pipeline_deleted_placed_openings_restored',
        tenant_id: args.tenant_id,
        pipeline_id: args.id,
        requisition_id: existing.requisition_id,
      });
      return;
    }
    // Non-placed delete: A5a behavior verbatim — the row never
    // decremented openings, nothing to restore.
    await this.prisma.pipeline.delete({ where: { id: args.id } });
  }

  // -------------------------------------------------------------------------
  // Write path — THE state-machine transition (directive §3)
  // -------------------------------------------------------------------------

  async transition(args: {
    tenant_id: string;
    id: string;
    to_status: PipelineStatus;
    changed_by_id: string;
    note?: string;
    requestId: string;
  }): Promise<PipelineView> {
    const current = await this.prisma.pipeline.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    });
    if (current === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Pipeline not found in tenant',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }

    const fromStatus = (current as PipelineRow).status;

    // Step 2 — no-op guard. Same status: return current view with no
    // history row, no activity row, no metering event.
    if (fromStatus === args.to_status) {
      this.logger.log({
        event: 'pipeline_transition_noop',
        tenant_id: args.tenant_id,
        pipeline_id: args.id,
        status: fromStatus,
      });
      return projectView(current as PipelineRow);
    }

    // Step 3 — legality check (the state machine). Illegal → 422.
    if (!canTransition(fromStatus, args.to_status)) {
      this.logger.log({
        event: 'pipeline_transition_refused',
        tenant_id: args.tenant_id,
        pipeline_id: args.id,
        code: 'INVALID_PIPELINE_TRANSITION',
        from_status: fromStatus,
        to_status: args.to_status,
      });
      throw new AramoError(
        'INVALID_PIPELINE_TRANSITION',
        `Illegal pipeline status transition: ${fromStatus} -> ${args.to_status}`,
        422,
        {
          requestId: args.requestId,
          details: {
            pipeline_id: args.id,
            from_status: fromStatus,
            to_status: args.to_status,
          },
        },
      );
    }

    // Step 4 — atomic interactive transaction (PR-A5b-1 widens the
    // composition with the placement decrement leg; the interactive form
    // preserves Ruling 6 atomicity AND allows the over-capacity guard to
    // throw mid-tx).
    //
    // The activity + metering writes go through insertActivityInTx /
    // recordUsage (cross-schema $executeRaw) so they share the SAME
    // Prisma client / transaction scope as the pipeline-internal writes.
    // Same DB, same tx — Ruling 6 atomicity.
    const subject_id = args.id;
    const tenant_id = args.tenant_id;
    const noteForActivity =
      args.note === undefined ? null : args.note;
    const note = args.note ?? null;
    const site_id = (current as PipelineRow).site_id ?? undefined;
    const requisition_id = (current as PipelineRow).requisition_id;
    const transitionNote =
      `pipeline ${fromStatus} -> ${args.to_status}` +
      (noteForActivity === null ? '' : `: ${noteForActivity}`);

    const { updatedRow, historyRow } = await this.prisma.$transaction(
      async (tx) => {
        // 4a — UPDATE Pipeline.status
        const updated = await tx.pipeline.update({
          where: { id: args.id },
          data: { status: args.to_status },
        });
        // 4b — INSERT PipelineStatusHistory
        const history = await tx.pipelineStatusHistory.create({
          data: {
            tenant_id,
            pipeline_id: args.id,
            status_from: fromStatus,
            status_to: args.to_status,
            changed_by_id: args.changed_by_id,
            note,
          },
        });
        // 4c — INSERT activity."Activity" (cross-schema raw insert).
        await insertActivityInTx(tx, {
          tenant_id,
          ...(site_id === undefined ? {} : { site_id }),
          type: 'pipeline_status_change',
          subject_type: 'pipeline',
          subject_id,
          notes: transitionNote,
          created_by_id: args.changed_by_id,
        });
        // 4d — INSERT metering."UsageEvent" (cross-schema raw insert).
        //      First ATS-domain metered event (Ruling 4).
        await recordUsage(tx, {
          tenant_id,
          event_type: 'pipeline.state_transition',
        });
        // 4e — (PR-A5b-1) placement-only: decrement
        //      requisition.openings_available with the optimistic
        //      `> 0` guard. Row count 0 → over-capacity → throw
        //      REQUISITION_NO_OPENINGS, which rolls back 4a-4d with 4e.
        //      The decrement writes ONLY requisition.openings_available
        //      — no Core table is read or written (the A5b boundary).
        if (args.to_status === 'placed') {
          const decremented = await tx.$executeRaw`
            UPDATE requisition."Requisition"
            SET openings_available = openings_available - 1
            WHERE id = ${requisition_id}::uuid
              AND tenant_id = ${tenant_id}::uuid
              AND openings_available > 0
          `;
          if (decremented === 0) {
            throw new AramoError(
              'REQUISITION_NO_OPENINGS',
              'Requisition has no available openings for placement',
              409,
              {
                requestId: args.requestId,
                details: {
                  pipeline_id: args.id,
                  requisition_id,
                  to_status: 'placed',
                },
              },
            );
          }
        }
        return { updatedRow: updated, historyRow: history };
      },
    );

    this.logger.log({
      event: 'pipeline_transitioned',
      tenant_id,
      pipeline_id: args.id,
      from_status: fromStatus,
      to_status: args.to_status,
      history_id: (historyRow as PipelineStatusHistoryRow).id,
      ...(args.to_status === 'placed'
        ? { openings_decremented: true, requisition_id }
        : {}),
    });
    return projectView(updatedRow as PipelineRow);
  }

  // -------------------------------------------------------------------------
  // Read path
  // -------------------------------------------------------------------------

  async findById(args: {
    tenant_id: string;
    id: string;
  }): Promise<PipelineView | null> {
    const row = await this.prisma.pipeline.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    });
    return row === null ? null : projectView(row as PipelineRow);
  }

  // AUTHZ-D4b — visibility-scoped read paths. Pipeline inherits its
  // requisition's visibility — the cascade filters on
  // `requisition_id IN visible_requisition_ids`. The visible
  // requisition IDs are pre-resolved by the controller (via
  // VisibilityResolverService) and passed in. null means see_all_
  // requisition → unrestricted.
  async findByIdForActor(args: {
    tenant_id: string;
    id: string;
    visible_requisition_ids: ReadonlySet<string> | null;
  }): Promise<PipelineView | null> {
    if (args.visible_requisition_ids !== null) {
      const row = await this.prisma.pipeline.findFirst({
        where: {
          tenant_id: args.tenant_id,
          id: args.id,
          requisition_id: { in: Array.from(args.visible_requisition_ids) },
        },
      });
      return row === null ? null : projectView(row as PipelineRow);
    }
    return this.findById({ tenant_id: args.tenant_id, id: args.id });
  }

  async listForActor(args: {
    tenant_id: string;
    visible_requisition_ids: ReadonlySet<string> | null;
    requisition_id?: string;
    talent_record_id?: string;
    limit?: number;
  }): Promise<PipelineView[]> {
    const limit = Math.min(args.limit ?? 50, 200);
    const where: Record<string, unknown> = { tenant_id: args.tenant_id };
    if (args.visible_requisition_ids !== null) {
      where['requisition_id'] = {
        in: Array.from(args.visible_requisition_ids),
      };
    }
    if (args.requisition_id !== undefined) {
      // narrow: caller wants ONE requisition; AND with the visibility set.
      if (
        args.visible_requisition_ids !== null &&
        !args.visible_requisition_ids.has(args.requisition_id)
      ) {
        return [];
      }
      where['requisition_id'] = args.requisition_id;
    }
    if (args.talent_record_id !== undefined) {
      where['talent_record_id'] = args.talent_record_id;
    }
    const rows = await this.prisma.pipeline.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limit,
    });
    return (rows as PipelineRow[]).map(projectView);
  }

  // Segment 3 — BATCH current-stage read for the talent-records list
  // enrichment. Set-based over the page's talent_record_id set (ONE query),
  // never per-row. Visibility honored: only pipelines on the actor's visible
  // requisitions are considered (`visible_requisition_ids = null` ⇒ see-all).
  // Derivation OWNED HERE (pipeline owns the funnel ordering): per talent, the
  // most-advanced ACTIVE membership by funnel ordinal; deterministic tie-break
  // (lowest requisition_id). Talents with no active membership are absent from
  // the map ("none" at the response layer).
  async findCurrentStageForTalentIds(args: {
    tenant_id: string;
    talent_record_ids: readonly string[];
    visible_requisition_ids: ReadonlySet<string> | null;
  }): Promise<Map<string, CurrentStage>> {
    if (args.talent_record_ids.length === 0) return new Map();
    const where: Record<string, unknown> = {
      tenant_id: args.tenant_id,
      talent_record_id: { in: [...args.talent_record_ids] },
      status: { in: [...ACTIVE_FLOW_STAGES] },
    };
    if (args.visible_requisition_ids !== null) {
      where['requisition_id'] = {
        in: Array.from(args.visible_requisition_ids),
      };
    }
    const rows = await this.prisma.pipeline.findMany({
      where,
      select: { talent_record_id: true, requisition_id: true, status: true },
    });
    const best = new Map<string, CurrentStage & { ord: number }>();
    for (const r of rows) {
      const stage = r.status as PipelineStatus;
      const ord = activeStageOrdinal(stage);
      if (ord < 0) continue; // belt-and-suspenders (query already filters)
      const cur = best.get(r.talent_record_id);
      const moreAdvanced = cur === undefined || ord > cur.ord;
      const tieBreak =
        cur !== undefined &&
        ord === cur.ord &&
        r.requisition_id < cur.requisition_id;
      if (moreAdvanced || tieBreak) {
        best.set(r.talent_record_id, {
          stage,
          requisition_id: r.requisition_id,
          ord,
        });
      }
    }
    const out = new Map<string, CurrentStage>();
    for (const [id, v] of best) {
      out.set(id, { stage: v.stage, requisition_id: v.requisition_id });
    }
    return out;
  }

  // Segment 4c — preset resolution ("Submitted · this week"). Returns the
  // DISTINCT talent_record ids that transitioned INTO `submitted` at/after
  // `since`, tenant-wide. PipelineStatusHistory carries the transition; the
  // talent id comes through the INTRA-schema relation to Pipeline (both live
  // in the pipeline schema — never a cross-schema join). Bounded by `limit`:
  // distinct pipelines, take limit+1, then dedup to talent ids (a talent with
  // two submitted pipelines folds to one).
  async findTalentIdsSubmittedSince(args: {
    tenant_id: string;
    since: Date;
    limit: number;
  }): Promise<string[]> {
    const rows = await this.prisma.pipelineStatusHistory.findMany({
      where: {
        tenant_id: args.tenant_id,
        status_to: 'submitted',
        changed_at: { gte: args.since },
      },
      select: { pipeline: { select: { talent_record_id: true } } },
      distinct: ['pipeline_id'],
      take: args.limit + 1,
      orderBy: { changed_at: 'desc' },
    });
    const ids = new Set<string>();
    for (const r of rows) ids.add(r.pipeline.talent_record_id);
    return [...ids];
  }

  /**
   * List pipelines. Optionally filter by requisition_id or talent_record_id
   * (the dominant recruiter-UI queries: "all talents on this req" and
   * "all reqs for this talent"). Tenant-scoped throughout.
   *
   * PR-A8-4 — `requisition_ids` (plural) accepts the A3-visible
   * requisition set resolved upstream. This is the same shape as
   * `count`'s `requisition_ids` arg (PR-A7) — pipeline.requisition_id
   * is a cross-schema logical UUID so Prisma can't traverse the
   * assignment relation in-query; the role-visibility predicate is
   * composed at the consuming service layer (export / reporting).
   * `requisition_id` (singular) and `requisition_ids` (plural) are
   * mutually exclusive — the export caller never sets both.
   */
  async list(args: {
    tenant_id: string;
    requisition_id?: string;
    requisition_ids?: readonly string[];
    talent_record_id?: string;
    limit?: number;
  }): Promise<PipelineView[]> {
    const limit = Math.min(args.limit ?? 50, 200);
    const rows = await this.prisma.pipeline.findMany({
      where: {
        tenant_id: args.tenant_id,
        ...(args.requisition_id === undefined
          ? {}
          : { requisition_id: args.requisition_id }),
        ...(args.requisition_ids === undefined
          ? {}
          : { requisition_id: { in: [...args.requisition_ids] } }),
        ...(args.talent_record_id === undefined
          ? {}
          : { talent_record_id: args.talent_record_id }),
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
    return (rows as PipelineRow[]).map(projectView);
  }

  // PR-A7 — tenant-scoped count. The reporting aggregator may pass a
  // pre-computed list of visible requisition_ids (the A3 predicate is
  // resolved upstream in RequisitionRepository.countForActor + listed
  // requisition_ids — pipeline.requisition_id is a cross-schema logical
  // ref so Prisma can't traverse the assignment relation in-query, so
  // the role-visibility predicate is composed at the service layer).
  async count(args: {
    tenant_id: string;
    requisition_ids?: readonly string[];
    status?: PipelineStatus;
  }): Promise<number> {
    return this.prisma.pipeline.count({
      where: {
        tenant_id: args.tenant_id,
        ...(args.requisition_ids === undefined
          ? {}
          : { requisition_id: { in: [...args.requisition_ids] } }),
        ...(args.status === undefined ? {} : { status: args.status }),
      },
    });
  }

  // PR-A7 — per-PipelineStatus rollup for the reporting aggregator.
  // The optional requisition_ids list applies the upstream-resolved A3
  // role-visibility predicate.
  async countByStatus(args: {
    tenant_id: string;
    requisition_ids?: readonly string[];
  }): Promise<Array<{ status: PipelineStatus; count: number }>> {
    const rows = await this.prisma.pipeline.groupBy({
      by: ['status'],
      where: {
        tenant_id: args.tenant_id,
        ...(args.requisition_ids === undefined
          ? {}
          : { requisition_id: { in: [...args.requisition_ids] } }),
      },
      _count: { _all: true },
    });
    return rows.map((r) => ({
      status: r.status as PipelineStatus,
      count: r._count._all,
    }));
  }

  // Per-company metrics — group pipeline counts by requisition_id for a status
  // set, so the reporting service can fold them up to the company via the
  // req→company map (cross-schema id-list pattern; pipeline.requisition_id is a
  // logical ref). Empty id list short-circuits (groupBy on IN [] is wasteful).
  async countByRequisition(args: {
    tenant_id: string;
    requisition_ids: readonly string[];
    statuses: readonly PipelineStatus[];
  }): Promise<Array<{ requisition_id: string; count: number }>> {
    if (args.requisition_ids.length === 0 || args.statuses.length === 0) {
      return [];
    }
    const rows = await this.prisma.pipeline.groupBy({
      by: ['requisition_id'],
      where: {
        tenant_id: args.tenant_id,
        requisition_id: { in: [...args.requisition_ids] },
        status: { in: [...args.statuses] },
      },
      _count: { _all: true },
    });
    return rows.map((r) => ({
      requisition_id: r.requisition_id as string,
      count: r._count._all,
    }));
  }

  async listHistory(args: {
    tenant_id: string;
    pipeline_id: string;
  }): Promise<PipelineStatusHistoryView[]> {
    const rows = await this.prisma.pipelineStatusHistory.findMany({
      where: {
        tenant_id: args.tenant_id,
        pipeline_id: args.pipeline_id,
      },
      orderBy: { changed_at: 'asc' },
    });
    return (rows as PipelineStatusHistoryRow[]).map(projectHistoryView);
  }

  // AUTHZ-D4b — return the SET of pipeline IDs whose requisition is in
  // the visible-requisition set. Consumed by VisibilityResolverService
  // to memoize `visible_pipeline_ids` for the activity polymorphic OR.
  // Empty input → []; the resolver short-circuits on requisition see-all.
  async findIdsForRequisitions(args: {
    tenant_id: string;
    requisition_ids: readonly string[];
  }): Promise<string[]> {
    if (args.requisition_ids.length === 0) return [];
    const rows = await this.prisma.pipeline.findMany({
      where: {
        tenant_id: args.tenant_id,
        requisition_id: { in: Array.from(args.requisition_ids) },
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
