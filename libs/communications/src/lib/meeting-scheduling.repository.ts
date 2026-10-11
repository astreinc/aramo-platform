import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// COMM-C2B Amendment A1 (M365-SCHED-1, R3/R5) — persistence for the opt-in Outlook
// scheduling capability. Owns the durable scheduling-operation ledger (written
// BEFORE any Graph call), the CommunicationInteraction scheduling reads/writes with
// an optimistic-concurrency version (CAS reschedule/cancel), the upcoming-meeting
// projection, and the forensic scheduling audit. Tenant-first throughout: a
// cross-tenant id is NOT FOUND, never an info leak.

export type MeetingOperationStatus = 'pending' | 'succeeded' | 'unresolved' | 'failed';

export interface MeetingOperationRow {
  id: string;
  tenant_id: string;
  idempotency_key: string;
  transaction_id: string;
  operation: string;
  status: MeetingOperationStatus;
  provider_event_id: string | null;
  interaction_id: string | null;
  organizer_id: string;
  talent_record_id: string;
  requisition_id: string;
  last_error: string | null;
}

export interface ScheduledMeetingRow {
  id: string;
  tenant_id: string;
  status: string;
  version: number;
  provider_event_id: string | null;
  join_reference: string | null;
  initiated_by_id: string | null;
  started_at: Date | null;
  ended_at: Date | null;
}

export interface MeetingAuditInput {
  tenant_id: string;
  actor_id: string | null;
  actor_type: string;
  event_type: string;
  interaction_id?: string | null;
  operation_id?: string | null;
  provider_event_id?: string | null;
  talent_record_id?: string | null;
  requisition_id?: string | null;
  outcome: string;
  event_payload: Record<string, unknown>;
}

@Injectable()
export class MeetingSchedulingRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- durable scheduling-operation ledger (R3) ----

  /**
   * Idempotency anchor (R3): create the pending operation, or — if one already
   * exists for (tenant, idempotency_key) — return it unchanged. The returned
   * `created` flag lets the caller distinguish a first attempt from a retry.
   * transaction_id is stable across retries (the Graph provider-dedup guard).
   */
  /**
   * Atomically claim the durable scheduling operation (FIX_NOW-2). The unique
   * (tenant, idempotency_key) index + a status-CAS reclaim make this the single
   * serialization point for a create: exactly one caller may hold a live (pending)
   * operation at a time, and the idempotency key is bound to its ORIGINAL tenant,
   * organizer, and request identity. Outcomes:
   *   - `created`      — we own a fresh pending op (or re-claimed an unresolved/failed
   *                      one for a safe retry; transaction_id is stable across retries).
   *   - `replay`       — a prior attempt already succeeded; return its meeting.
   *   - `in_progress`  — a concurrent attempt holds the op; the caller must NOT
   *                      independently proceed (prevents a duplicate provider call).
   *   - `identity_conflict` — the key was reused with a different tenant/organizer/
   *                      Talent/Requisition; reject (no unauthorized success replay).
   */
  async claimSchedulingOperation(args: {
    tenant_id: string;
    idempotency_key: string;
    transaction_id: string;
    organizer_id: string;
    talent_record_id: string;
    requisition_id: string;
  }): Promise<{ outcome: 'created' | 'replay' | 'in_progress' | 'identity_conflict'; op: MeetingOperationRow | null }> {
    try {
      const op = (await this.prisma.meetingSchedulingOperation.create({
        data: {
          tenant_id: args.tenant_id,
          idempotency_key: args.idempotency_key,
          transaction_id: args.transaction_id,
          operation: 'create',
          status: 'pending',
          organizer_id: args.organizer_id,
          talent_record_id: args.talent_record_id,
          requisition_id: args.requisition_id,
        },
      })) as MeetingOperationRow;
      return { outcome: 'created', op };
    } catch {
      // Unique (tenant, idempotency_key) conflict — an operation already exists.
    }
    const existing = await this.findOperation(args.tenant_id, args.idempotency_key);
    if (existing === null) {
      throw new Error('scheduling operation claim failed');
    }
    // The idempotency key is bound to its original identity + request (FIX_NOW-2):
    // reusing it with different input is NEVER an authorized success replay.
    if (
      existing.organizer_id !== args.organizer_id ||
      existing.talent_record_id !== args.talent_record_id ||
      existing.requisition_id !== args.requisition_id
    ) {
      return { outcome: 'identity_conflict', op: existing };
    }
    if (existing.status === 'succeeded' && existing.interaction_id !== null) {
      return { outcome: 'replay', op: existing };
    }
    if (existing.status === 'pending') {
      return { outcome: 'in_progress', op: existing };
    }
    // unresolved | failed → atomically reclaim for a safe retry; exactly one winner.
    const reclaimed = await this.prisma.meetingSchedulingOperation.updateMany({
      where: { id: existing.id, status: { in: ['unresolved', 'failed'] } },
      data: { status: 'pending', last_error: null },
    });
    return reclaimed.count === 1
      ? { outcome: 'created', op: existing }
      : { outcome: 'in_progress', op: existing };
  }

  async findOperation(
    tenant_id: string,
    idempotency_key: string,
  ): Promise<MeetingOperationRow | null> {
    return (await this.prisma.meetingSchedulingOperation.findFirst({
      where: { tenant_id, idempotency_key },
    })) as MeetingOperationRow | null;
  }

  async markOperation(
    id: string,
    patch: { status: MeetingOperationStatus; provider_event_id?: string; interaction_id?: string; last_error?: string },
  ): Promise<void> {
    await this.prisma.meetingSchedulingOperation.update({
      where: { id },
      data: {
        status: patch.status,
        provider_event_id: patch.provider_event_id,
        interaction_id: patch.interaction_id,
        last_error: patch.last_error,
      },
    });
  }

  // ---- scheduled meeting (CommunicationInteraction channel=meeting) ----

  /**
   * Create the scheduled-meeting evidence row (channel=meeting, status=scheduled,
   * version=0) with the Outlook provider_event_id + Teams join reference, plus the
   * Talent `subject` and Requisition `regarding` associations — all in ONE tx, so a
   * meeting row is never persisted without its associations.
   */
  async createScheduledMeeting(args: {
    tenant_id: string;
    integration_connection_id: string;
    organizer_id: string;
    from_address: string;
    to_address: string;
    provider_event_id: string;
    join_reference: string | null;
    started_at: Date;
    ended_at: Date;
    subject: string;
    talent_record_id: string;
    requisition_id: string;
    pipeline_id?: string | null;
  }): Promise<ScheduledMeetingRow> {
    return (await this.prisma.$transaction(async (tx) => {
      const interaction = await tx.communicationInteraction.create({
        data: {
          tenant_id: args.tenant_id,
          channel: 'meeting',
          direction: 'outbound',
          status: 'scheduled',
          integration_connection_id: args.integration_connection_id,
          from_address: args.from_address,
          to_address: args.to_address,
          initiated_by_id: args.organizer_id,
          provider_event_id: args.provider_event_id,
          join_reference: args.join_reference,
          subject: args.subject,
          started_at: args.started_at,
          ended_at: args.ended_at,
        },
      });
      await tx.communicationAssociation.create({
        data: {
          tenant_id: args.tenant_id,
          interaction_id: interaction.id,
          subject_type: 'talent_record',
          subject_id: args.talent_record_id,
          relation_type: 'subject',
        },
      });
      await tx.communicationAssociation.create({
        data: {
          tenant_id: args.tenant_id,
          interaction_id: interaction.id,
          subject_type: 'requisition',
          subject_id: args.requisition_id,
          relation_type: 'regarding',
        },
      });
      if (args.pipeline_id !== undefined && args.pipeline_id !== null && args.pipeline_id.length > 0) {
        await tx.communicationAssociation.create({
          data: {
            tenant_id: args.tenant_id,
            interaction_id: interaction.id,
            subject_type: 'pipeline',
            subject_id: args.pipeline_id,
            relation_type: 'regarding',
          },
        });
      }
      return interaction as ScheduledMeetingRow;
    })) as ScheduledMeetingRow;
  }

  async findScheduledMeeting(
    tenant_id: string,
    interaction_id: string,
  ): Promise<ScheduledMeetingRow | null> {
    return (await this.prisma.communicationInteraction.findFirst({
      where: { tenant_id, id: interaction_id, channel: 'meeting' },
    })) as ScheduledMeetingRow | null;
  }

  /**
   * CAS RESERVATION (FIX_NOW-1): the eligibility gate that runs BEFORE any Graph
   * side effect. Atomically advance the version iff the row still matches
   * `expected_version` and is active (scheduled|rescheduled). count===0 → conflict
   * (stale version, a concurrent writer won, or already cancelled) → the caller must
   * NOT touch Outlook. count===1 → reserved: this caller exclusively owns the
   * transition at `expected_version + 1`; only then is the provider mutated. The
   * reservation advances `version` only — the user-visible status/times are applied
   * by `finalizeReschedule`/`finalizeCancel` AFTER the provider confirms, so a Graph
   * failure never leaves a premature success claim.
   */
  async reserveMutationCas(args: {
    tenant_id: string;
    interaction_id: string;
    expected_version: number;
  }): Promise<{ conflict: boolean; reserved_version: number }> {
    const res = await this.prisma.communicationInteraction.updateMany({
      where: {
        id: args.interaction_id,
        tenant_id: args.tenant_id,
        channel: 'meeting',
        version: args.expected_version,
        status: { in: ['scheduled', 'rescheduled'] },
      },
      data: { version: { increment: 1 } },
    });
    return { conflict: res.count === 0, reserved_version: args.expected_version + 1 };
  }

  /** Finalize a reserved reschedule AFTER Graph confirms (same provider event, R3). */
  async finalizeReschedule(args: {
    tenant_id: string;
    interaction_id: string;
    reserved_version: number;
    started_at: Date;
    ended_at: Date;
  }): Promise<void> {
    await this.prisma.communicationInteraction.updateMany({
      where: {
        id: args.interaction_id,
        tenant_id: args.tenant_id,
        channel: 'meeting',
        version: args.reserved_version,
      },
      data: { status: 'rescheduled', started_at: args.started_at, ended_at: args.ended_at },
    });
  }

  /** Finalize a reserved cancel AFTER Graph confirms (same provider event, R3). */
  async finalizeCancel(args: {
    tenant_id: string;
    interaction_id: string;
    reserved_version: number;
  }): Promise<void> {
    await this.prisma.communicationInteraction.updateMany({
      where: {
        id: args.interaction_id,
        tenant_id: args.tenant_id,
        channel: 'meeting',
        version: args.reserved_version,
      },
      data: { status: 'cancelled' },
    });
  }

  /**
   * Upcoming meetings by Talent/Requisition context (last-known synchronized state,
   * R6 — never represented as guaranteed-live Outlook). Active states only, within
   * the date window, filtered by a Talent or Requisition association.
   */
  async listUpcomingMeetings(args: {
    tenant_id: string;
    talent_record_id?: string;
    requisition_id?: string;
    from: Date;
    to: Date;
  }): Promise<ScheduledMeetingRow[]> {
    const assocFilters: { subject_type: 'talent_record' | 'requisition'; subject_id: string }[] = [];
    if (args.talent_record_id !== undefined) {
      assocFilters.push({ subject_type: 'talent_record', subject_id: args.talent_record_id });
    }
    if (args.requisition_id !== undefined) {
      assocFilters.push({ subject_type: 'requisition', subject_id: args.requisition_id });
    }
    const rows = await this.prisma.communicationInteraction.findMany({
      where: {
        tenant_id: args.tenant_id,
        channel: 'meeting',
        status: { in: ['scheduled', 'rescheduled'] },
        started_at: { gte: args.from, lte: args.to },
        ...(assocFilters.length > 0
          ? { associations: { some: { tenant_id: args.tenant_id, OR: assocFilters } } }
          : {}),
      },
      orderBy: { started_at: 'asc' },
    });
    return rows as ScheduledMeetingRow[];
  }

  // ---- forensic scheduling audit (R5) ----

  async writeAudit(input: MeetingAuditInput): Promise<void> {
    await this.prisma.meetingSchedulingAuditEvent.create({
      data: {
        tenant_id: input.tenant_id,
        actor_id: input.actor_id,
        actor_type: input.actor_type,
        event_type: input.event_type,
        interaction_id: input.interaction_id ?? null,
        operation_id: input.operation_id ?? null,
        provider_event_id: input.provider_event_id ?? null,
        talent_record_id: input.talent_record_id ?? null,
        requisition_id: input.requisition_id ?? null,
        outcome: input.outcome,
        event_payload: input.event_payload as object,
      },
    });
  }
}
