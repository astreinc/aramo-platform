import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AramoError } from '@aramo/common';

import { PrismaService } from './prisma/prisma.service.js';
import {
  canMoveStatus,
  isReopen,
  isResolvedStatus,
  isUnresolvedStatus,
  isWaiverPermitted,
  requiredAuthorityFor,
  type RequirementStatusValue,
  type WaiverModeValue,
} from './pre-start-requirement-vocab.js';
import type {
  AuditView,
  BlockerProjection,
  BlockingAssessment,
  InstanceView,
  SetView,
  StatusMoveInput,
  WaiveInput,
} from './pre-start-requirement.types.js';

interface InstanceRow {
  id: string;
  tenant_id: string;
  placement_process_id: string;
  definition_set_id: string;
  definition_set_version: string;
  definition_set_checksum: string;
  requirement_definition_id: string;
  requirement_type: string;
  label: string;
  blocking: boolean;
  owner_role: string | null;
  waiver_mode: string;
  status: string;
  completed_at: Date | null;
  completed_by: string | null;
  evidence_reference: string | null;
  created_at: Date;
  updated_at: Date;
}
interface AuditRow {
  id: string;
  tenant_id: string;
  requirement_instance_id: string;
  action: string;
  actor_id: string;
  actor_type: string;
  authority: string | null;
  reason: string | null;
  justification: string | null;
  source: string | null;
  previous_status: string;
  resulting_status: string;
  created_at: Date;
}

function projectInstance(r: InstanceRow): InstanceView {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    placement_process_id: r.placement_process_id,
    definition_set_id: r.definition_set_id,
    definition_set_version: r.definition_set_version,
    definition_set_checksum: r.definition_set_checksum,
    requirement_definition_id: r.requirement_definition_id,
    requirement_type: r.requirement_type as InstanceView['requirement_type'],
    label: r.label,
    blocking: r.blocking,
    owner_role: r.owner_role,
    waiver_mode: r.waiver_mode as WaiverModeValue,
    status: r.status as RequirementStatusValue,
    completed_at: r.completed_at,
    completed_by: r.completed_by,
    evidence_reference: r.evidence_reference,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}
function projectAudit(r: AuditRow): AuditView {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    requirement_instance_id: r.requirement_instance_id,
    action: r.action,
    actor_id: r.actor_id,
    actor_type: r.actor_type,
    authority: r.authority,
    reason: r.reason,
    justification: r.justification,
    source: r.source,
    previous_status: r.previous_status as RequirementStatusValue,
    resulting_status: r.resulting_status as RequirementStatusValue,
    created_at: r.created_at,
  };
}

// RequirementInstanceRepository — placement-bound instance materialization,
// governed status moves, snapshot-anchored waivers, immutable audit provenance,
// and blocking assessment (Track 3 / E2, §4 / §14 A2).
//
// The lib performs NO placement transition and stores NO placement-level flag.
// It exposes assessment (assessBlocking) that the apps/api readiness gate reads.
@Injectable()
export class RequirementInstanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Materialize the snapshot for a placement from a resolved published set.
  // IDEMPOTENT: at most one instance per (tenant, placement, requirement_type) —
  // a re-entry (BLOCKED -> PRE_START recovery) never re-snapshots or re-versions.
  // Returns the full instance set for the placement (existing + newly created).
  async materialize(
    tenant_id: string,
    placement_process_id: string,
    set: SetView,
  ): Promise<readonly InstanceView[]> {
    const existing = (await this.prisma.preStartRequirementInstance.findMany({
      where: { tenant_id, placement_process_id },
    })) as InstanceRow[];
    const have = new Set(existing.map((r) => r.requirement_type));

    const toCreate = set.definitions.filter((d) => !have.has(d.requirement_type));
    if (toCreate.length > 0) {
      // createMany with skipDuplicates is the race-safe floor against the
      // (tenant, placement, requirement_type) unique index.
      await this.prisma.preStartRequirementInstance.createMany({
        data: toCreate.map((d) => ({
          id: uuidv7(),
          tenant_id,
          placement_process_id,
          definition_set_id: set.id,
          definition_set_version: set.version,
          definition_set_checksum: set.checksum,
          requirement_definition_id: d.id,
          requirement_type: d.requirement_type,
          label: d.label,
          blocking: d.blocking,
          owner_role: d.owner_role,
          waiver_mode: d.waiver_mode,
          status: 'PENDING',
        })),
        skipDuplicates: true,
      });
    }
    return this.findByPlacement(tenant_id, placement_process_id);
  }

  async findByPlacement(tenant_id: string, placement_process_id: string): Promise<readonly InstanceView[]> {
    const rows = (await this.prisma.preStartRequirementInstance.findMany({
      where: { tenant_id, placement_process_id },
      orderBy: { created_at: 'asc' },
    })) as InstanceRow[];
    return rows.map(projectInstance);
  }

  async findById(tenant_id: string, id: string): Promise<InstanceView | null> {
    const row = (await this.prisma.preStartRequirementInstance.findFirst({
      where: { tenant_id, id },
    })) as InstanceRow | null;
    return row === null ? null : projectInstance(row);
  }

  // A non-waiver status move (SATISFIED / FAILED / CANCELED, or REOPENED -> PENDING).
  // Waivers MUST go through waive() — this path refuses WAIVED.
  async applyStatusMove(input: StatusMoveInput, requestId: string): Promise<InstanceView> {
    if (input.to === 'WAIVED') {
      throw this.invalid('a waiver must be applied through the waiver path', requestId, {
        requirement_instance_id: input.requirement_instance_id,
      });
    }
    const current = await this.loadForMove(input.tenant_id, input.requirement_instance_id, requestId);
    const from = current.status as RequirementStatusValue;
    if (!canMoveStatus(from, input.to)) {
      throw this.invalidMove(from, input.to, requestId, input.requirement_instance_id);
    }
    // IN_PROGRESS is an operational claim, not a consequential action: advance the
    // status with NO audit row (matches the DB provenance invariant, which does
    // not require provenance for a move to IN_PROGRESS).
    if (input.to === 'IN_PROGRESS') {
      // State-guarded CAS: the row must still be in the captured `from` status. A
      // concurrent move that already advanced it matches 0 rows → conflict (never a
      // silent last-write-wins).
      const res = await this.prisma.preStartRequirementInstance.updateMany({
        where: { id: current.id, tenant_id: input.tenant_id, status: from },
        data: { status: 'IN_PROGRESS' },
      });
      if (res.count === 0) throw this.conflict(current.id, from, 'IN_PROGRESS', requestId);
      const row = (await this.prisma.preStartRequirementInstance.findFirst({
        where: { tenant_id: input.tenant_id, id: current.id },
      })) as InstanceRow;
      return projectInstance(row);
    }
    const action = isReopen(from, input.to) ? 'REOPENED' : input.to;
    return this.commitMove(current, input.to, action, requestId, {
      tenant_id: input.tenant_id,
      actor_id: input.actor_id,
      actor_type: input.actor_type,
      reason: input.reason ?? null,
      justification: input.justification ?? null,
      source: input.source ?? null,
      authority: null,
      completed_by: input.completed_by ?? null,
      evidence_reference: input.evidence_reference ?? null,
    });
  }

  // Waive a blocking/non-blocking requirement. The waiver is evaluated against
  // the SNAPSHOTTED waiver_mode, never the live definition — closing the
  // check-then-act race. NOT_WAIVABLE is refused unconditionally: no authority,
  // no scope, no fallback can waive it. The caller's SCOPE authority
  // (pre_start_requirement:waive_blocking) is enforced upstream in apps/api; this
  // is the domain floor.
  async waive(input: WaiveInput, requestId: string): Promise<InstanceView> {
    const current = await this.loadForMove(input.tenant_id, input.requirement_instance_id, requestId);
    const from = current.status as RequirementStatusValue;
    const mode = current.waiver_mode as WaiverModeValue;

    if (requiredAuthorityFor(mode) === null) {
      throw new AramoError(
        'PRE_START_REQUIREMENT_INVALID',
        'this requirement was materialized as NOT_WAIVABLE and can never be waived',
        422,
        {
          requestId,
          details: { requirement_instance_id: current.id, waiver_mode: mode, snapshot_enforced: true },
        },
      );
    }
    if (!isWaiverPermitted(mode, input.authority)) {
      throw this.invalid('the asserted waiver authority does not satisfy the snapshotted waiver_mode', requestId, {
        requirement_instance_id: current.id,
        waiver_mode: mode,
        authority: input.authority,
      });
    }
    if (!canMoveStatus(from, 'WAIVED')) {
      throw this.invalidMove(from, 'WAIVED', requestId, current.id);
    }
    if (input.justification.trim().length === 0) {
      throw this.invalid('a waiver requires a justification', requestId, { requirement_instance_id: current.id });
    }
    return this.commitMove(current, 'WAIVED', 'WAIVED', requestId, {
      tenant_id: input.tenant_id,
      actor_id: input.actor_id,
      actor_type: input.actor_type,
      reason: null,
      justification: input.justification,
      source: input.source ?? null,
      authority: input.authority,
      completed_by: null,
      evidence_reference: null,
    });
  }

  async listAudits(tenant_id: string, requirement_instance_id: string): Promise<readonly AuditView[]> {
    const rows = (await this.prisma.preStartRequirementAudit.findMany({
      where: { tenant_id, requirement_instance_id },
      orderBy: { created_at: 'asc' },
    })) as AuditRow[];
    return rows.map(projectAudit);
  }

  // L5-P4 (ruling P3) — the BLOCKED projection. The authoritative cause of a block is
  // a blocking requirement in FAILED (intervention needed); PENDING/IN_PROGRESS
  // blocking requirements are normal outstanding onboarding (PRE_START), not a block.
  // Derived from the requirement facts — no separate blocker store (no duplicate truth).
  async deriveBlockers(tenant_id: string, placement_process_id: string): Promise<BlockerProjection> {
    const instances = await this.findByPlacement(tenant_id, placement_process_id);
    const failed_blocking = instances.filter((i) => i.blocking && i.status === 'FAILED');
    return { placement_process_id, blocked: failed_blocking.length > 0, failed_blocking };
  }

  // The lib's readiness contribution. No snapshot => materialized:false =>
  // ready:false (fail-closed). ready only when every blocking instance is resolved.
  async assessBlocking(tenant_id: string, placement_process_id: string): Promise<BlockingAssessment> {
    const instances = await this.findByPlacement(tenant_id, placement_process_id);
    if (instances.length === 0) {
      return { placement_process_id, materialized: false, total: 0, unresolved_blocking: [], ready: false };
    }
    const unresolved_blocking = instances.filter((i) => i.blocking && isUnresolvedStatus(i.status));
    return {
      placement_process_id,
      materialized: true,
      total: instances.length,
      unresolved_blocking,
      ready: unresolved_blocking.length === 0,
    };
  }

  // ---- helpers ----------------------------------------------------------------

  private async loadForMove(tenant_id: string, id: string, requestId: string): Promise<InstanceRow> {
    const row = (await this.prisma.preStartRequirementInstance.findFirst({
      where: { tenant_id, id },
    })) as InstanceRow | null;
    if (row === null) {
      throw new AramoError('NOT_FOUND', 'PreStartRequirementInstance not found', 404, {
        requestId,
        details: { requirement_instance_id: id, reason: 'instance_not_found' },
      });
    }
    return row;
  }

  private async commitMove(
    current: InstanceRow,
    to: RequirementStatusValue,
    action: string,
    requestId: string,
    meta: {
      tenant_id: string;
      actor_id: string;
      actor_type: string;
      reason: string | null;
      justification: string | null;
      source: string | null;
      authority: string | null;
      completed_by: string | null;
      evidence_reference: string | null;
    },
  ): Promise<InstanceView> {
    const from = current.status as RequirementStatusValue;
    const now = new Date();
    // Resolved statuses stamp completion; REOPENED clears it.
    const resolved = isResolvedStatus(to);
    const updated = await this.prisma.$transaction(async (tx) => {
      // State-guarded CAS inside the tx: the row must still be in the captured `from`
      // status. Postgres row-locks the UPDATE and re-evaluates the predicate, so a
      // concurrent move that already advanced the row matches 0 rows → conflict. This
      // closes the double-audit race (two writers appending contradictory provenance);
      // exactly one move commits, the loser is told to re-read (409, not silent).
      const res = await tx.preStartRequirementInstance.updateMany({
        where: { id: current.id, tenant_id: meta.tenant_id, status: from },
        data: {
          status: to,
          completed_at: resolved ? now : null,
          completed_by: resolved ? meta.completed_by : null,
          // evidence_reference is set only on a forward resolution that carries one.
          ...(meta.evidence_reference !== null ? { evidence_reference: meta.evidence_reference } : {}),
        },
      });
      if (res.count === 0) throw this.conflict(current.id, from, to, requestId);
      const u = (await tx.preStartRequirementInstance.findFirst({
        where: { tenant_id: meta.tenant_id, id: current.id },
      })) as InstanceRow;
      await tx.preStartRequirementAudit.create({
        data: {
          id: uuidv7(),
          tenant_id: meta.tenant_id,
          requirement_instance_id: current.id,
          action,
          actor_id: meta.actor_id,
          actor_type: meta.actor_type,
          authority: meta.authority,
          reason: meta.reason,
          justification: meta.justification,
          source: meta.source,
          previous_status: from,
          resulting_status: to,
        },
      });
      return u;
    });
    return projectInstance(updated);
  }

  private invalid(message: string, requestId: string, details: Record<string, unknown>): AramoError {
    return new AramoError('PRE_START_REQUIREMENT_INVALID', message, 422, { requestId, details });
  }
  // The state-guarded CAS lost: the instance moved out of the expected `from` status
  // under a concurrent writer between load and commit. A distinct 409 (never a silent
  // last-write-wins); the caller re-reads and retries.
  private conflict(
    requirement_instance_id: string,
    from: RequirementStatusValue,
    to: RequirementStatusValue,
    requestId: string,
  ): AramoError {
    return new AramoError(
      'PRE_START_REQUIREMENT_CONFLICT',
      `requirement status move conflict: the instance is no longer in ${from} (a concurrent move advanced it)`,
      409,
      {
        requestId,
        details: {
          requirement_instance_id,
          expected_from_status: from,
          attempted_to_status: to,
          reason: 'concurrent_status_move',
        },
      },
    );
  }
  private invalidMove(
    from: RequirementStatusValue,
    to: RequirementStatusValue,
    requestId: string,
    requirement_instance_id: string,
  ): AramoError {
    return new AramoError(
      'PRE_START_REQUIREMENT_INVALID',
      `illegal requirement status move: ${from} -> ${to}`,
      422,
      { requestId, details: { requirement_instance_id, from_status: from, to_status: to } },
    );
  }
}
