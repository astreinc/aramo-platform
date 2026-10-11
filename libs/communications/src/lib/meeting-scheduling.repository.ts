import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// COMM-C2B Amendment A1 (M365-SCHED-1, R3/R5) — persistence for the opt-in Outlook
// scheduling capability. Owns the durable scheduling-operation ledger (written
// BEFORE any Graph call), the CommunicationInteraction scheduling reads/writes with
// an optimistic-concurrency version (CAS reschedule/cancel), the upcoming-meeting
// projection, and the forensic scheduling audit. Tenant-first throughout: a
// cross-tenant id is NOT FOUND, never an info leak.

// A pending create older than this is treated as ABANDONED (process crash mid-flight):
// its provider outcome is uncertain, so it surfaces for reconciliation rather than
// blocking the key forever or being silently recreated (FIX-4). A Graph create never
// legitimately takes this long, so a fresh pending is a genuine concurrent attempt.
export const PENDING_ABANDON_TTL_MS = 10 * 60 * 1000;

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
  request_fingerprint: string | null;
  last_error: string | null;
  created_at: Date;
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
  mutation_locked_at: Date | null;
  // Durable intent of the fenced mutation (PR#918 reconciliation pass): what the
  // reservation was trying to do, so recovery can verify provider truth against it.
  pending_mutation: string | null;
  pending_start: Date | null;
  pending_end: Date | null;
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
   * Atomically claim the durable scheduling operation (FIX_NOW-2, PR#918 final pass).
   * The unique (tenant, idempotency_key) index + a status-CAS reclaim make this the
   * single serialization point for a create: exactly one caller may hold a live
   * (pending) operation at a time, and the key is bound to the FULL immutable request
   * identity via `request_fingerprint`. Outcomes:
   *   - `created`              — we own a fresh pending op, OR re-claimed a `failed`
   *                              op (definitively no provider event was created → safe
   *                              retry; transaction_id is stable across retries).
   *   - `replay`               — a prior attempt already succeeded; return its meeting.
   *   - `in_progress`          — a FRESH concurrent attempt holds the op; the caller
   *                              must NOT independently proceed (no duplicate provider call).
   *   - `needs_reconciliation` — the op is in an UNCERTAIN state (`unresolved`, or an
   *                              abandoned stale `pending`): the provider outcome may
   *                              have landed. NEVER auto-recreate — surface for bounded
   *                              operational reconciliation.
   *   - `identity_conflict`    — the key was reused with ANY changed request field
   *                              (fingerprint mismatch); reject, including success replay.
   */
  async claimSchedulingOperation(args: {
    tenant_id: string;
    idempotency_key: string;
    transaction_id: string;
    organizer_id: string;
    talent_record_id: string;
    requisition_id: string;
    request_fingerprint: string;
  }): Promise<{
    outcome: 'created' | 'replay' | 'in_progress' | 'needs_reconciliation' | 'identity_conflict';
    op: MeetingOperationRow | null;
  }> {
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
          request_fingerprint: args.request_fingerprint,
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
    // FIX-3: the key is bound to the FULL immutable request. Any changed field (subject,
    // window, timezone, connection, organizer, Talent, Requisition) → NEVER a replay.
    if (existing.request_fingerprint !== args.request_fingerprint) {
      return { outcome: 'identity_conflict', op: existing };
    }
    if (existing.status === 'succeeded' && existing.interaction_id !== null) {
      return { outcome: 'replay', op: existing };
    }
    if (existing.status === 'failed') {
      // A `failed` op created NO provider event (pre-provider error or a deterministic
      // provider rejection) → safe to reclaim for a retry; exactly one winner.
      const reclaimed = await this.prisma.meetingSchedulingOperation.updateMany({
        where: { id: existing.id, status: 'failed' },
        data: { status: 'pending', last_error: null },
      });
      return reclaimed.count === 1
        ? { outcome: 'created', op: existing }
        : { outcome: 'in_progress', op: existing };
    }
    if (existing.status === 'unresolved') {
      // Provider outcome UNCERTAIN — a Graph event may have been created. NEVER
      // auto-recreate; surface for bounded operational reconciliation.
      return { outcome: 'needs_reconciliation', op: existing };
    }
    // pending: a FRESH pending op is a genuine concurrent attempt (in_progress); a stale
    // one is abandoned (process crash mid-flight) and, like `unresolved`, its provider
    // outcome is uncertain → reconcile, never silently recreate.
    const abandoned = existing.created_at.getTime() < Date.now() - PENDING_ABANDON_TTL_MS;
    return abandoned
      ? { outcome: 'needs_reconciliation', op: existing }
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
   * CAS RESERVATION + EXCLUSIVE FENCE (FIX_NOW-1 + PR#918 FIX-1): the eligibility gate
   * BEFORE any Graph side effect. Atomically, iff the row matches `expected_version`,
   * is active (scheduled|rescheduled), AND is NOT already mutation-locked: advance the
   * version AND acquire the mutation lock (`mutation_locked_at`). count===0 → conflict
   * (stale version, a concurrent writer won, already cancelled, OR another mutation
   * holds the lock) → the caller must NOT touch Outlook. count===1 → reserved: this
   * caller EXCLUSIVELY owns the transition until `finalize*` (success) or
   * `reconcileLockedMutation` (recovery) releases the lock. A second reservation is
   * refused even at the post-reservation version, so two mutations can never reach
   * Graph concurrently. The user-visible status/times are applied by `finalize*` AFTER
   * the provider confirms, so a Graph failure never leaves a premature success claim.
   */
  async reserveMutationCas(args: {
    tenant_id: string;
    interaction_id: string;
    expected_version: number;
    now: Date;
    // Durable intent stamped WITH the fence (PR#918 reconciliation pass): a reschedule
    // carries the intended target window so recovery can verify the provider actually
    // moved to it; a cancel carries no window.
    mutation: 'reschedule' | 'cancel';
    target_start?: Date | null;
    target_end?: Date | null;
  }): Promise<{ conflict: boolean; reserved_version: number }> {
    const res = await this.prisma.communicationInteraction.updateMany({
      where: {
        id: args.interaction_id,
        tenant_id: args.tenant_id,
        channel: 'meeting',
        version: args.expected_version,
        status: { in: ['scheduled', 'rescheduled'] },
        mutation_locked_at: null,
      },
      data: {
        version: { increment: 1 },
        mutation_locked_at: args.now,
        pending_mutation: args.mutation,
        pending_start: args.mutation === 'reschedule' ? (args.target_start ?? null) : null,
        pending_end: args.mutation === 'reschedule' ? (args.target_end ?? null) : null,
      },
    });
    return { conflict: res.count === 0, reserved_version: args.expected_version + 1 };
  }

  /**
   * Finalize a reserved reschedule AFTER Graph confirms (same provider event, R3).
   * CHECKED (PR#918 FIX-2): applies ONLY to the row we still exclusively hold
   * (reserved_version + lock held) and RELEASES the lock; returns whether exactly one
   * row changed. count!==1 → the finalize did NOT land → the caller must NOT emit a
   * success audit (the state is uncertain and stays locked for reconciliation).
   */
  async finalizeReschedule(args: {
    tenant_id: string;
    interaction_id: string;
    reserved_version: number;
    started_at: Date;
    ended_at: Date;
  }): Promise<{ ok: boolean }> {
    const res = await this.prisma.communicationInteraction.updateMany({
      where: {
        id: args.interaction_id,
        tenant_id: args.tenant_id,
        channel: 'meeting',
        version: args.reserved_version,
        mutation_locked_at: { not: null },
      },
      data: {
        status: 'rescheduled',
        started_at: args.started_at,
        ended_at: args.ended_at,
        mutation_locked_at: null,
        pending_mutation: null,
        pending_start: null,
        pending_end: null,
      },
    });
    return { ok: res.count === 1 };
  }

  /** Finalize a reserved cancel AFTER Graph confirms (same provider event, R3). CHECKED. */
  async finalizeCancel(args: {
    tenant_id: string;
    interaction_id: string;
    reserved_version: number;
  }): Promise<{ ok: boolean }> {
    const res = await this.prisma.communicationInteraction.updateMany({
      where: {
        id: args.interaction_id,
        tenant_id: args.tenant_id,
        channel: 'meeting',
        version: args.reserved_version,
        mutation_locked_at: { not: null },
      },
      data: {
        status: 'cancelled',
        mutation_locked_at: null,
        pending_mutation: null,
        pending_start: null,
        pending_end: null,
      },
    });
    return { ok: res.count === 1 };
  }

  /**
   * Recovery (PR#918 FIX-4): reconcile a meeting whose mutation lock is held but whose
   * provider outcome could not be confirmed (a Graph failure after reservation, or an
   * abandoned mutation). The caller supplies the reconciled terminal state after
   * reading the provider event; this releases the fence so the meeting is mutable
   * again. Bounded + explicit — never an automatic provider re-issue.
   */
  async reconcileLockedMutation(args: {
    tenant_id: string;
    interaction_id: string;
    resolved_status: 'scheduled' | 'rescheduled' | 'cancelled';
  }): Promise<{ ok: boolean }> {
    const res = await this.prisma.communicationInteraction.updateMany({
      where: {
        id: args.interaction_id,
        tenant_id: args.tenant_id,
        channel: 'meeting',
        mutation_locked_at: { not: null },
      },
      data: {
        status: args.resolved_status,
        mutation_locked_at: null,
        pending_mutation: null,
        pending_start: null,
        pending_end: null,
      },
    });
    return { ok: res.count === 1 };
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
