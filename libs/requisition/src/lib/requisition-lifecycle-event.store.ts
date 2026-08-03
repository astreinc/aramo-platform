import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';
import type { RecruitingStatus } from './dto/requisition-status.js';

// RequisitionLifecycleEventStore — the APPEND-ONLY write API for the
// requisition entity's lifecycle mutation history (ADR-0024 §D17c). §D17a
// provenance records WHY a command was permitted; this records WHETHER/HOW the
// state change was applied. Every governed transition writes one record.
//
// Append-only by construction: this store exposes `record` (the sole write
// path) plus reads — there is NO update method and NO delete method. A
// lifecycle event is history, never mutated. This is NOT event sourcing; it
// captures status transitions only, not a general field-level change log.
//
// @Injectable so PR-5 can wire it via DI; PR-0c ships NO consumer, controller,
// endpoint, or NestJS module. Tests construct it directly.

/** Where a governed transition was initiated (§D8). */
export type RequisitionLifecycleOrigin = 'ui' | 'agent' | 'integration';

/** One lifecycle transition to record. §D17c fields. */
export interface RecordRequisitionLifecycleEventInput {
  readonly tenant_id: string;
  readonly requisition_id: string;
  /**
   * WHAT changed. next_status is always present. previous_status is null ONLY
   * on a create (T1-c R1) — the first status has no predecessor; every
   * update-driven transition carries a non-null previous_status.
   */
  readonly previous_status: RecruitingStatus | null;
  readonly next_status: RecruitingStatus;
  readonly actor_id: string;
  readonly origin: RequisitionLifecycleOrigin;
  readonly reason_code: string;
  /**
   * The policy decision (policy_store.PolicyDecisionRecord.id) that permitted
   * the transition — a cross-schema UUID reference, no FK. Supplied whenever a
   * decision exists; null/omitted only for a transition predating policy
   * governance (§D17c).
   */
  readonly policy_decision_id?: string | null;
  readonly correlation_id: string;
  /** When the transition was applied. Defaults to now. */
  readonly occurred_at?: Date;
}

/** A persisted lifecycle event, read back. */
export interface RequisitionLifecycleEvent {
  readonly id: string;
  readonly tenant_id: string;
  readonly requisition_id: string;
  /** Null only for a create event (T1-c R1). */
  readonly previous_status: RecruitingStatus | null;
  readonly next_status: RecruitingStatus;
  readonly actor_id: string;
  readonly origin: RequisitionLifecycleOrigin;
  readonly reason_code: string;
  readonly policy_decision_id: string | null;
  readonly occurred_at: Date;
  readonly correlation_id: string;
}

interface EventRow {
  id: string;
  tenant_id: string;
  requisition_id: string;
  previous_status: string | null;
  next_status: string;
  actor_id: string;
  origin: string;
  reason_code: string;
  policy_decision_id: string | null;
  occurred_at: Date;
  correlation_id: string;
}

@Injectable()
export class RequisitionLifecycleEventStore {
  constructor(private readonly prisma: PrismaService) {}

  private static toEvent(row: EventRow): RequisitionLifecycleEvent {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      requisition_id: row.requisition_id,
      previous_status:
        row.previous_status === null
          ? null
          : (row.previous_status as RecruitingStatus),
      next_status: row.next_status as RecruitingStatus,
      actor_id: row.actor_id,
      origin: row.origin as RequisitionLifecycleOrigin,
      reason_code: row.reason_code,
      policy_decision_id: row.policy_decision_id,
      occurred_at: row.occurred_at,
      correlation_id: row.correlation_id,
    };
  }

  /** Append one lifecycle event. The only write path — history, never mutated. */
  async record(
    input: RecordRequisitionLifecycleEventInput,
  ): Promise<RequisitionLifecycleEvent> {
    const row = (await this.prisma.requisitionLifecycleEvent.create({
      data: {
        id: uuidv7(),
        tenant_id: input.tenant_id,
        requisition_id: input.requisition_id,
        previous_status: input.previous_status,
        next_status: input.next_status,
        actor_id: input.actor_id,
        origin: input.origin,
        reason_code: input.reason_code,
        policy_decision_id: input.policy_decision_id ?? null,
        correlation_id: input.correlation_id,
        ...(input.occurred_at === undefined
          ? {}
          : { occurred_at: input.occurred_at }),
      },
    })) as EventRow;
    return RequisitionLifecycleEventStore.toEvent(row);
  }

  /** Read one event by id (tenant-scoped), or null. */
  async getById(
    tenantId: string,
    id: string,
  ): Promise<RequisitionLifecycleEvent | null> {
    const row = (await this.prisma.requisitionLifecycleEvent.findFirst({
      where: { tenant_id: tenantId, id },
    })) as EventRow | null;
    return row === null ? null : RequisitionLifecycleEventStore.toEvent(row);
  }

  /** All events for one command (correlation id), oldest first. Tenant-scoped. */
  async listByCorrelation(
    tenantId: string,
    correlationId: string,
  ): Promise<RequisitionLifecycleEvent[]> {
    const rows = (await this.prisma.requisitionLifecycleEvent.findMany({
      where: { tenant_id: tenantId, correlation_id: correlationId },
      orderBy: { occurred_at: 'asc' },
    })) as EventRow[];
    return rows.map((row) => RequisitionLifecycleEventStore.toEvent(row));
  }

  /** All events for one requisition, oldest first. Tenant isolation via the predicate. */
  async listByRequisition(
    tenantId: string,
    requisitionId: string,
  ): Promise<RequisitionLifecycleEvent[]> {
    const rows = (await this.prisma.requisitionLifecycleEvent.findMany({
      where: { tenant_id: tenantId, requisition_id: requisitionId },
      orderBy: { occurred_at: 'asc' },
    })) as EventRow[];
    return rows.map((row) => RequisitionLifecycleEventStore.toEvent(row));
  }
}
