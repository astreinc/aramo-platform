import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { insertActivityInTx } from '@aramo/activity';
import { recordUsage } from '@aramo/metering';
import {
  insertPolicyDecisionRecordInTx,
  type InsertPolicyDecisionRecordInput,
} from '@aramo/policy-store';

import type { PipelineView } from './dto/pipeline.view.js';
import type { PipelineStatusHistoryView } from './dto/pipeline-status-history.view.js';
import type { CreatePipelineRequestDto } from './dto/create-pipeline-request.dto.js';
import {
  canTransition,
  ACTIVE_FLOW_STAGES,
  activeStageOrdinal,
  isLiveStatus,
  TERMINAL_STATUSES,
  type PipelineStatus,
} from './pipeline-state.js';
import { PrismaService } from './prisma/prisma.service.js';

// §4.1 race-floor identification — a concurrent insert that lost the race on the
// LIVE-scoped partial unique surfaces a Prisma P2002 naming `Pipeline_live_episode_key`
// SPECIFICALLY. This is deliberately narrow: E6 replaces the old generic-P2002
// design, so an arbitrary uniqueness violation must NOT be swallowed here.
function isLiveEpisodeIndexViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; meta?: { target?: unknown }; message?: unknown };
  if (e.code !== 'P2002') return false;
  const target = e.meta?.target;
  const named = 'Pipeline_live_episode_key';
  const inTarget =
    (typeof target === 'string' && target.includes(named)) ||
    (Array.isArray(target) && target.some((t) => typeof t === 'string' && t.includes(named)));
  const inMessage = typeof e.message === 'string' && e.message.includes(named);
  return inTarget || inMessage;
}

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
  version: number;
}

interface PipelineStatusHistoryRow {
  id: string;
  tenant_id: string;
  pipeline_id: string;
  status_from: PipelineStatus | null;
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
    version: row.version,
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

  // TR-2a-B3b (DDR-3 §4) + E6 A4 PRESERVE-ALL — OPERATIONAL re-point.
  //
  // Post-E6 Pipeline no longer has a TOTAL unique on (talent, requisition): multiple
  // HISTORICAL episodes may coexist (Q-1). Reconciliation therefore PRESERVES ALL
  // episodes — it re-points every `from` row to `to`, keeping row IDs and
  // PipelineStatusHistory intact. It does NOT physically delete a "collision loser"
  // and does NOT infer a duplicate from status/timestamps/site_id (A4 — the
  // provenance to make that call does not exist in the substrate; inventing an
  // identity is forbidden). `removed_rows` is therefore ALWAYS empty for pipeline.
  //
  // Q-2 safety: repointing a LIVE `from` row onto a `to` that already has a LIVE row
  // for the same requisition would violate the partial live index. That live/live
  // case is refused PRE-FLIGHT by the orchestrator BEFORE any sweep begins (§5.2),
  // so by the time this runs no live/live collision remains. Atomic (one tx),
  // idempotent (a re-run matches no `from` rows).
  async repointTalentRecordRefs(args: {
    tenant_id: string;
    from_record_id: string;
    to_record_id: string;
    // Reversal (DDR-3 §6): re-point ONLY these specific rows (restoring exactly what
    // the operation moved, by recorded id).
    only_ids?: string[];
  }): Promise<{ repointed_ids: string[]; removed_rows: unknown[] }> {
    if (args.only_ids && args.only_ids.length > 0) {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `UPDATE "pipeline"."Pipeline" SET talent_record_id = $1::uuid
           WHERE talent_record_id = $2::uuid AND tenant_id = $3::uuid AND id = ANY($4::uuid[])
         RETURNING id`,
        args.to_record_id, args.from_record_id, args.tenant_id, args.only_ids,
      );
      return { repointed_ids: rows.map((r) => r.id), removed_rows: [] };
    }
    // PRESERVE-ALL — re-point EVERY `from` row to `to`. No collision DELETE.
    const repointed = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `UPDATE "pipeline"."Pipeline" SET talent_record_id = $1::uuid
         WHERE talent_record_id = $2::uuid AND tenant_id = $3::uuid
       RETURNING id`,
      args.to_record_id, args.from_record_id, args.tenant_id,
    );
    return { repointed_ids: repointed.map((r) => r.id), removed_rows: [] };
  }

  // E6 A4 — detect a LIVE/LIVE reconciliation conflict BEFORE any mutation. Returns
  // the requisition_ids where BOTH the `from` and `to` records hold a LIVE episode:
  // repointing would put two live episodes on one (tenant, talent, requisition)
  // triple, which Q-2 forbids. The orchestrator refuses pre-flight on a non-empty
  // result (§5.2); the partial live index is the backstop beneath.
  async findLiveEpisodeConflicts(args: {
    tenant_id: string;
    from_record_id: string;
    to_record_id: string;
  }): Promise<string[]> {
    const terminals = [...TERMINAL_STATUSES];
    const rows = await this.prisma.$queryRawUnsafe<Array<{ requisition_id: string }>>(
      `SELECT DISTINCT a.requisition_id
         FROM "pipeline"."Pipeline" a
         JOIN "pipeline"."Pipeline" b
           ON a.tenant_id = b.tenant_id AND a.requisition_id = b.requisition_id
        WHERE a.tenant_id = $1::uuid
          AND a.talent_record_id = $2::uuid
          AND b.talent_record_id = $3::uuid
          AND NOT (a.status::text = ANY($4::text[]))
          AND NOT (b.status::text = ANY($4::text[]))`,
      args.tenant_id, args.from_record_id, args.to_record_id, terminals,
    );
    return rows.map((r) => r.requisition_id);
  }

  // TR-2a-B3b (DDR-3 §6) — reversal re-creates the recorded-and-removed collision
  // rows verbatim (each row's full pre-removal content is in the operation record;
  // it carries the original talent_record_id = R_L). Idempotent: a row whose id is
  // already present is skipped (the @@unique also protects). Re-inserts each row's
  // stored columns as-is.
  async restoreRemovedRows(rows: Array<Record<string, unknown>>): Promise<void> {
    for (const row of rows) {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "pipeline"."Pipeline"
           (id, tenant_id, site_id, talent_record_id, requisition_id, status, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::"pipeline"."PipelineStatus", $7::timestamptz, $8::timestamptz)
         ON CONFLICT (id) DO NOTHING`,
        row['id'], row['tenant_id'], row['site_id'] ?? null, row['talent_record_id'],
        row['requisition_id'], row['status'], row['created_at'], row['updated_at'],
      );
    }
  }

  // -------------------------------------------------------------------------
  // Write path — create at no_contact
  // -------------------------------------------------------------------------

  async create(args: {
    tenant_id: string;
    input: CreatePipelineRequestDto;
    requestId?: string;
    // ADR-0024 §D17a — when a policy decision governed this add (the
    // recruiter-console path), its provenance record commits INSIDE the same
    // transaction as the pipeline row: atomic (§D10 fail-closed). If the
    // provenance write fails, the pipeline row is rolled back and the command
    // fails closed. Omitted on the still-ungated sourcing path (PR-3b).
    provenance?: InsertPolicyDecisionRecordInput;
    // Lane 2 / L2-B — the actor recorded on the birth history row (NULL -> no_contact).
    created_by_id?: string;
  }): Promise<PipelineView> {
    // Initial state hard-coded to `no_contact` per directive §2 /
    // state-machine proof initial-state invariant. Body cannot override.
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        // E6 Q-2 — one-live-episode application guard (the deterministic path).
        // At most one LIVE episode per (tenant, talent, requisition); terminal
        // episodes are preserved history and do NOT occupy the slot. This is the
        // documented refusal callers receive; the Pipeline_live_episode_key
        // partial index is the race floor beneath it (translated below).
        const live = await tx.pipeline.findFirst({
          where: {
            tenant_id: args.tenant_id,
            talent_record_id: args.input.talent_record_id,
            requisition_id: args.input.requisition_id,
            status: { notIn: [...TERMINAL_STATUSES] },
          },
          select: { id: true },
        });
        if (live !== null) {
          throw this.liveEpisodeError(args);
        }
        const created = await tx.pipeline.create({
          data: {
            tenant_id: args.tenant_id,
            site_id: args.input.site_id ?? null,
            talent_record_id: args.input.talent_record_id,
            requisition_id: args.input.requisition_id,
            status: 'no_contact',
          },
        });
        // Lane 2 / L2-B — the birth history row (NULL -> no_contact) so the
        // append-only audit is complete from the episode's first instant.
        await tx.pipelineStatusHistory.create({
          data: {
            tenant_id: args.tenant_id,
            pipeline_id: created.id,
            status_from: null,
            status_to: 'no_contact',
            changed_by_id: args.created_by_id ?? null,
          },
        });
        // Lane 2 / L2-B — the canonical creation event, emitted in-tx (a rolled-back
        // create leaves NO orphan outbox row). Drained by libs/outbox-publisher.
        await tx.outboxEvent.create({
          data: {
            tenant_id: args.tenant_id,
            event_type: 'pipeline.created',
            event_payload: {
              pipeline_id: created.id,
              talent_record_id: args.input.talent_record_id,
              requisition_id: args.input.requisition_id,
            },
          },
        });
        if (args.provenance !== undefined) {
          // Cross-schema, same-tx write (mirrors insertActivityInTx).
          await insertPolicyDecisionRecordInTx(tx, args.provenance);
        }
        return created;
      });
      return projectView(row as PipelineRow);
    } catch (err) {
      // §4.1 race floor — a concurrent insert lost on Pipeline_live_episode_key.
      // Translate that EXACT violation to the same deterministic refusal; never
      // catch an arbitrary P2002/23505.
      if (isLiveEpisodeIndexViolation(err)) {
        throw this.liveEpisodeError(args);
      }
      throw err;
    }
  }

  // E6 Q-2 — the one-live-episode refusal (409). Used by BOTH the deterministic
  // pre-check and the race-floor translation, so the outward contract is identical
  // whichever path fires.
  private liveEpisodeError(args: {
    tenant_id: string;
    input: CreatePipelineRequestDto;
    requestId?: string;
  }): AramoError {
    return new AramoError(
      'PIPELINE_EPISODE_ALREADY_LIVE',
      'A live pipeline episode already exists for this talent and requisition',
      409,
      {
        // Controller always threads the real requestId; the sourcing path catches
        // this error (idempotent no-op) so its sentinel never reaches a response.
        requestId: args.requestId ?? 'pipeline-create',
        details: {
          talent_record_id: args.input.talent_record_id,
          requisition_id: args.input.requisition_id,
        },
      },
    );
  }

  // Standalone §D17a provenance write for a DENY: there is no mutation to be
  // atomic with, so the record is written on its own. A failed provenance
  // write here does not change the outcome — denial is already the safe
  // result (§D10).
  async recordDecision(provenance: InsertPolicyDecisionRecordInput): Promise<void> {
    await insertPolicyDecisionRecordInTx(this.prisma, provenance);
  }

  // Lane 2 / L2-B — the ordinary hard DELETE is WITHDRAWN. Re-entry never
  // depended on it: a terminal episode releases the live slot (E6 partial index)
  // and create() admits a fresh episode. A durable recruiting audit must not be
  // casually destructible, and the DB-layer append-only trigger on
  // PipelineStatusHistory now rejects the cascade delete outside a governed
  // tenant-reset. Legal/privacy erasure remains the tenant-reset service's
  // authorized-GUC purge path (the exact-value reset escape, set only by that
  // service, then a raw purge).

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
    // Lane 2 / L2-A — optimistic-concurrency token the caller last read.
    expected_version: number;
    // Lane 2 / L2-A — AUTHZ-D4b write-visibility parity. The actor's visible
    // requisition set (null ⇒ see-all-requisition). A pipeline on a requisition
    // outside this set is CONCEALED as 404 — identical to a missing row — so a
    // caller can neither read nor mutate a row they cannot see.
    visible_requisition_ids: ReadonlySet<string> | null;
  }): Promise<PipelineView> {
    const current = await this.prisma.pipeline.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    });
    // Concealment: missing row, OR a row whose requisition is not visible to the
    // actor, both surface as the SAME 404 — existence is never leaked (Lane 1
    // write-visibility invariant, extended to the transition write path).
    if (
      current === null ||
      (args.visible_requisition_ids !== null &&
        !args.visible_requisition_ids.has((current as PipelineRow).requisition_id))
    ) {
      throw new AramoError(
        'NOT_FOUND',
        'Pipeline not found in tenant (or not visible to actor)',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }

    // Optimistic-concurrency compare-and-swap (Lane 2 / L2-A). A stale
    // expected_version means a concurrent transition already advanced the row;
    // refuse before any write so last-write-wins cannot silently clobber. The
    // check precedes the no-op / legality checks because a stale version means
    // the caller's view of `status` (which drove `to_status`) is itself stale.
    const currentVersion = (current as PipelineRow).version;
    if (args.expected_version !== currentVersion) {
      this.logger.log({
        event: 'pipeline_transition_conflict',
        tenant_id: args.tenant_id,
        pipeline_id: args.id,
        code: 'PIPELINE_TRANSITION_CONFLICT',
        expected_version: args.expected_version,
        current_version: currentVersion,
      });
      throw new AramoError(
        'PIPELINE_TRANSITION_CONFLICT',
        'Pipeline was modified concurrently; refresh and retry',
        409,
        {
          requestId: args.requestId,
          details: {
            pipeline_id: args.id,
            current_status: (current as PipelineRow).status,
            current_version: currentVersion,
          },
        },
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

    // L8-B1 Amendment A1 (R-TIGHTEN) — pipeline `submitted` is the recruiting
    // MIRROR of an authoritative client submittal (Submittal.submitted_to_ats).
    // A bare pipeline transition to `submitted` MUST NOT independently create the
    // business fact; it is reachable ONLY through the submit-to-ats command
    // (which writes the mirror atomically). Narrow: every OTHER transition is
    // unchanged.
    if (args.to_status === 'submitted') {
      throw new AramoError(
        'PIPELINE_SUBMIT_REQUIRES_SUBMITTAL',
        'Pipeline "submitted" is a mirror of a client submittal; use POST /v1/submittals/{id}/submit-to-ats',
        409,
        {
          requestId: args.requestId,
          details: { pipeline_id: args.id, to_status: args.to_status },
        },
      );
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

    // Lane 2 / L2-B — episode terminal timestamp on the live -> terminal flip.
    // Derived from isLiveStatus so it AUTO-TRACKS the L2-C partition; captured ONCE
    // so `ended_at` and the outbox event carry the same transition instant.
    const enteringTerminal =
      isLiveStatus(fromStatus) && !isLiveStatus(args.to_status);
    const eventInstant = new Date();
    const talent_record_id = (current as PipelineRow).talent_record_id;

    const { updatedRow, historyRow } = await this.prisma.$transaction(
      async (tx) => {
        // 4a — UPDATE Pipeline.status (+ bump the optimistic-concurrency version
        // in the SAME tx; L2-A). The CAS was validated above; the increment
        // commits atomically with the status/history/activity/metering writes.
        const updated = await tx.pipeline.update({
          where: { id: args.id },
          data: {
            status: args.to_status,
            version: { increment: 1 },
            // L2-B — write the terminal timestamp exactly once, on the live ->
            // terminal flip. Terminal rows have no outgoing edge, so this is
            // structurally write-once (no immutability trigger needed).
            ...(enteringTerminal
              ? { ended_at: eventInstant, ended_by_id: args.changed_by_id }
              : {}),
          },
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
        // 4e — INSERT pipeline."OutboxEvent" (Lane 2 / L2-B) in the SAME tx, so a
        // rolled-back transition leaves NO orphan event. Drained by outbox-publisher.
        await tx.outboxEvent.create({
          data: {
            tenant_id,
            event_type: 'pipeline.state_transition',
            event_payload: {
              pipeline_id: args.id,
              talent_record_id,
              requisition_id,
              from_status: fromStatus,
              to_status: args.to_status,
              version: updated.version,
            },
          },
        });
        // Track 4 / T4-B2 §7 — PIPELINE CAPACITY AUTHORITY REMOVED. The former
        // `placed`-edge decrement of requisition.openings_available (the E6 boolean
        // EXISTS(placed) ±1 mechanism, and its REQUISITION_NO_OPENINGS 409 over-
        // capacity guard) is GONE. Capacity truth is now DERIVED from the ACTIVE
        // ContractAssignment population (placement-owned); a pipeline `placed`
        // transition is a recruiting fact and MUST NOT independently mutate
        // requisition capacity. Over-capacity is a representable derived state
        // (signed capacity_balance < 0), not a pipeline-time hard gate. Proven by
        // pipeline-capacity-authority-removed-b2.integration.spec.ts.
        return { updatedRow: updated, historyRow: history };
      },
    );

    this.logger.log({
      event: 'pipeline_transitioned',
      tenant_id,
      pipeline_id: args.id,
      from_status: fromStatus,
      to_status: args.to_status,
      requisition_id,
      history_id: (historyRow as PipelineStatusHistoryRow).id,
      // T4-B2 §7 — NO openings_decremented: a `placed` transition no longer
      // mutates requisition capacity (that authority moved to ContractAssignment).
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

  // PR-A7 + E6 Q-4 — per-PipelineStatus rollup for the reporting aggregator, as a
  // BUSINESS (person) view: each (talent, requisition) is collapsed to its CURRENT
  // episode (live if any, else latest terminal by created_at DESC, id DESC) and
  // counted ONCE, in that current stage. A re-entered talent with a historical
  // terminal episode plus a current live one is NOT double-counted (§7 / Q-4).
  // For single-episode data (the only shape possible before E6) DISTINCT ON returns
  // every row, so this is identical to the old groupBy. This is a BUSINESS helper —
  // NEVER call it from an episode/history view (those must show all episodes).
  // The optional requisition_ids list applies the upstream-resolved A3 predicate.
  async countByStatus(args: {
    tenant_id: string;
    requisition_ids?: readonly string[];
  }): Promise<Array<{ status: PipelineStatus; count: number }>> {
    const terminals = [...TERMINAL_STATUSES];
    const hasReqFilter = args.requisition_ids !== undefined;
    const reqClause = hasReqFilter ? `AND requisition_id = ANY($3::uuid[])` : '';
    const params: unknown[] = hasReqFilter
      ? [args.tenant_id, terminals, [...args.requisition_ids!]]
      : [args.tenant_id, terminals];
    const rows = await this.prisma.$queryRawUnsafe<Array<{ status: string; count: bigint }>>(
      `SELECT status, count(*)::bigint AS count FROM (
         SELECT DISTINCT ON (talent_record_id, requisition_id) status
         FROM "pipeline"."Pipeline"
         WHERE tenant_id = $1::uuid ${reqClause}
         ORDER BY talent_record_id, requisition_id,
                  (status::text = ANY($2::text[])) ASC,
                  created_at DESC, id DESC
       ) cur
       GROUP BY status`,
      ...params,
    );
    return rows.map((r) => ({
      status: r.status as PipelineStatus,
      count: Number(r.count),
    }));
  }

  // E6 Q-4 — count DISTINCT (talent, requisition) triples that have a `placed`
  // episode EXISTING (a placement is a fact about a human on a requisition, not a
  // per-episode event). Coexisting placed episodes for one triple count ONCE.
  // BUSINESS helper — not an episode view.
  async countDistinctPlaced(args: {
    tenant_id: string;
    requisition_ids?: readonly string[];
  }): Promise<number> {
    const hasReqFilter = args.requisition_ids !== undefined;
    const reqClause = hasReqFilter ? `AND requisition_id = ANY($2::uuid[])` : '';
    const params: unknown[] = hasReqFilter
      ? [args.tenant_id, [...args.requisition_ids!]]
      : [args.tenant_id];
    const rows = await this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM (
         SELECT DISTINCT talent_record_id, requisition_id
         FROM "pipeline"."Pipeline"
         WHERE tenant_id = $1::uuid AND status = 'placed'::"pipeline"."PipelineStatus" ${reqClause}
       ) t`,
      ...params,
    );
    return Number(rows[0]?.count ?? 0n);
  }

  // E6 Q-4 — per-requisition distinct-triple counts for company metrics. `placed`
  // uses EXISTS semantics (a placement is a fact); the funnel band {submitted,
  // interviewing, offered} uses CURRENT-episode semantics (who is currently in that
  // band). Both dedupe by (talent, requisition). BUSINESS helper — not an episode view.
  async countDistinctByRequisition(args: {
    tenant_id: string;
    requisition_ids: readonly string[];
    statuses: readonly PipelineStatus[];
    mode: 'exists' | 'current';
  }): Promise<Array<{ requisition_id: string; count: number }>> {
    if (args.requisition_ids.length === 0 || args.statuses.length === 0) return [];
    const terminals = [...TERMINAL_STATUSES];
    const reqIds = [...args.requisition_ids];
    const statuses = [...args.statuses];
    let sql: string;
    let params: unknown[];
    if (args.mode === 'exists') {
      // Distinct talents with an EXISTING episode in the status set, per req.
      sql =
        `SELECT requisition_id, count(DISTINCT talent_record_id)::bigint AS count
           FROM "pipeline"."Pipeline"
          WHERE tenant_id = $1::uuid
            AND requisition_id = ANY($2::uuid[])
            AND status::text = ANY($3::text[])
          GROUP BY requisition_id`;
      params = [args.tenant_id, reqIds, statuses];
    } else {
      // Distinct talents whose CURRENT episode is in the status set, per req.
      sql =
        `SELECT requisition_id, count(*)::bigint AS count FROM (
           SELECT DISTINCT ON (talent_record_id, requisition_id) requisition_id, status
             FROM "pipeline"."Pipeline"
            WHERE tenant_id = $1::uuid AND requisition_id = ANY($2::uuid[])
            ORDER BY talent_record_id, requisition_id,
                     (status::text = ANY($4::text[])) ASC, created_at DESC, id DESC
         ) cur
         WHERE status::text = ANY($3::text[])
         GROUP BY requisition_id`;
      params = [args.tenant_id, reqIds, statuses, terminals];
    }
    const rows = await this.prisma.$queryRawUnsafe<Array<{ requisition_id: string; count: bigint }>>(sql, ...params);
    return rows.map((r) => ({ requisition_id: r.requisition_id, count: Number(r.count) }));
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

  // Per-company placements — list pipeline rows in a status set for a set of
  // requisitions (reporting folds them to the company). Returns the minimal
  // projection the placements surface needs. Empty id list short-circuits.
  async listByRequisitionsAndStatus(args: {
    tenant_id: string;
    requisition_ids: readonly string[];
    statuses: readonly PipelineStatus[];
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      talent_record_id: string;
      requisition_id: string;
      status: PipelineStatus;
    }>
  > {
    if (args.requisition_ids.length === 0 || args.statuses.length === 0) {
      return [];
    }
    const rows = await this.prisma.pipeline.findMany({
      where: {
        tenant_id: args.tenant_id,
        requisition_id: { in: [...args.requisition_ids] },
        status: { in: [...args.statuses] },
      },
      select: {
        id: true,
        talent_record_id: true,
        requisition_id: true,
        status: true,
      },
      orderBy: { updated_at: 'desc' },
      take: Math.min(args.limit ?? 100, 500),
    });
    return rows.map((r) => ({
      id: r.id as string,
      talent_record_id: r.talent_record_id as string,
      requisition_id: r.requisition_id as string,
      status: r.status as PipelineStatus,
    }));
  }

  // T9-B1 — the FIRST `placed` transition per (talent, requisition), for the
  // reporting fill-rate numerator + time-to-fill completion (directive §5;
  // amendment D-1/D-2). Reads PipelineStatusHistory rows that transitioned
  // INTO `placed`, joining the INTRA-schema Pipeline relation for
  // talent_record_id + requisition_id (both live in the pipeline schema —
  // never a cross-schema join). MIN(changed_at) per (talent, requisition)
  // collapses multiple placed episodes for the same human on the same req to
  // the FIRST placed instant, so a later duplicate placed episode neither
  // double-counts (fill) nor advances completion (TTF). Bounded by the
  // caller's cohort requisition_ids (already [from,to)+A3-scoped upstream);
  // empty id list short-circuits. DB-side aggregation (D-6) — no capped
  // in-memory fold. BUSINESS helper — not an episode/history view.
  async listFirstPlacedByRequisitions(args: {
    tenant_id: string;
    requisition_ids: readonly string[];
  }): Promise<
    Array<{
      requisition_id: string;
      talent_record_id: string;
      first_placed_at: Date;
    }>
  > {
    if (args.requisition_ids.length === 0) return [];
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        requisition_id: string;
        talent_record_id: string;
        first_placed_at: Date;
      }>
    >(
      `SELECT p.requisition_id   AS requisition_id,
              p.talent_record_id AS talent_record_id,
              MIN(h.changed_at)  AS first_placed_at
         FROM "pipeline"."PipelineStatusHistory" h
         JOIN "pipeline"."Pipeline" p ON p.id = h.pipeline_id
        WHERE h.tenant_id = $1::uuid
          AND h.status_to = 'placed'::"pipeline"."PipelineStatus"
          AND p.requisition_id = ANY($2::uuid[])
        GROUP BY p.requisition_id, p.talent_record_id`,
      args.tenant_id,
      [...args.requisition_ids],
    );
    return rows.map((r) => ({
      requisition_id: r.requisition_id,
      talent_record_id: r.talent_record_id,
      first_placed_at: r.first_placed_at,
    }));
  }

  async listHistory(args: {
    tenant_id: string;
    pipeline_id: string;
    requestId: string;
    // Lane 2 / L2-A — AUTHZ-D4b read-visibility parity. History of a pipeline on
    // a requisition outside the actor's visible set is CONCEALED as 404 (a
    // history read must not leak a row the actor cannot see).
    visible_requisition_ids: ReadonlySet<string> | null;
  }): Promise<PipelineStatusHistoryView[]> {
    // Concealment gate: resolve the parent pipeline's visibility BEFORE returning
    // any history. Missing OR not-visible both surface as the SAME 404.
    const parent = await this.prisma.pipeline.findFirst({
      where: { tenant_id: args.tenant_id, id: args.pipeline_id },
      select: { id: true, requisition_id: true },
    });
    if (
      parent === null ||
      (args.visible_requisition_ids !== null &&
        !args.visible_requisition_ids.has(parent.requisition_id as string))
    ) {
      throw new AramoError(
        'NOT_FOUND',
        'Pipeline not found in tenant (or not visible to actor)',
        404,
        { requestId: args.requestId, details: { id: args.pipeline_id } },
      );
    }
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

  // Recruiter-metrics — the pipelines (id + created_at) on a requisition set,
  // so the reporting service can window their status-history transitions and
  // compute time-to-submit. Cross-schema id-list pattern (the history rows key
  // on pipeline_id, not requisition_id). Empty id list short-circuits.
  async listForRequisitions(args: {
    tenant_id: string;
    requisition_ids: readonly string[];
    limit?: number;
  }): Promise<Array<{ id: string; requisition_id: string; created_at: Date }>> {
    if (args.requisition_ids.length === 0) return [];
    const rows = await this.prisma.pipeline.findMany({
      where: {
        tenant_id: args.tenant_id,
        requisition_id: { in: Array.from(args.requisition_ids) },
      },
      select: { id: true, requisition_id: true, created_at: true },
      take: Math.min(args.limit ?? 5000, 10000),
    });
    return rows.map((r) => ({
      id: r.id as string,
      requisition_id: r.requisition_id as string,
      created_at: r.created_at as Date,
    }));
  }

  // Recruiter-metrics — status-history transitions INTO a status set since a
  // cutoff, for a pipeline set (windowed). The dominant metrics read: "entered
  // submitted / interviewing / placed" over a recent window. The reporting
  // service buckets these in JS for the per-period counts + sparkline series.
  async listTransitionsInto(args: {
    tenant_id: string;
    pipeline_ids: readonly string[];
    statuses_to: readonly PipelineStatus[];
    since: Date;
  }): Promise<
    Array<{ pipeline_id: string; status_to: PipelineStatus; changed_at: Date }>
  > {
    if (args.pipeline_ids.length === 0 || args.statuses_to.length === 0) {
      return [];
    }
    const rows = await this.prisma.pipelineStatusHistory.findMany({
      where: {
        tenant_id: args.tenant_id,
        pipeline_id: { in: Array.from(args.pipeline_ids) },
        status_to: { in: Array.from(args.statuses_to) },
        changed_at: { gte: args.since },
      },
      select: { pipeline_id: true, status_to: true, changed_at: true },
    });
    return rows.map((r) => ({
      pipeline_id: r.pipeline_id as string,
      status_to: r.status_to as PipelineStatus,
      changed_at: r.changed_at as Date,
    }));
  }
}
