import { Inject, Injectable } from '@nestjs/common';
import type { AuthContextType } from '@aramo/auth';
import {
  MeetingSchedulingRepository,
  type ScheduledMeetingRow,
} from '@aramo/communications';
import {
  DelegatedAuthorizationService,
  GraphCalendarError,
  type GraphEventResult,
  MICROSOFT_CALENDAR_PORT,
  MICROSOFT_GRAPH_PORT,
  type MicrosoftCalendarPort,
  type MicrosoftGraphPort,
} from '@aramo/microsoft-graph';
import { TalentRecordRepository } from '@aramo/talent-record';

import {
  CALENDAR_INVITE_CONSENT_GATE,
  type CalendarInviteConsentGate,
} from './calendar-invite-consent-gate.port.js';
import { MeetingAssociationError, MeetingAssociationValidator } from './meeting-association.validator.js';
import { MicrosoftConfigResolver } from './microsoft-config.resolver.js';

// COMM-C2B Amendment A1 (M365-SCHED-1) — Outlook calendar scheduling orchestration.
// Opt-in capability, SEPARATE from create-link-only. Enforces (in order): recruiting
// association + tenant ownership (C-4), contacting consent before any invitation (R1),
// a durable scheduling operation BEFORE the Graph call with a stable transactionId
// provider-dedup guard (R3), ambiguous-outcome -> `unresolved` with NO blind
// duplicate creation (R3), organizer-bound mutation (R2), and CAS-guarded
// reschedule/cancel against the SAME Outlook event identity (R3). Reads are
// last-known synchronized state, never represented as guaranteed-live Outlook (R6).

export class MeetingScheduleUnresolvedError extends Error {
  constructor(readonly operation_id: string) {
    super('scheduling outcome unresolved; reconcile before retrying');
    this.name = 'MeetingScheduleUnresolvedError';
  }
}
export class MeetingNotFoundError extends Error {
  constructor() {
    super('scheduling meeting not found');
    this.name = 'MeetingNotFoundError';
  }
}
export class MeetingOrganizerMismatchError extends Error {
  constructor() {
    super('only the organizing recruiter may modify this meeting');
    this.name = 'MeetingOrganizerMismatchError';
  }
}
export class MeetingVersionConflictError extends Error {
  constructor() {
    super('meeting was modified concurrently; refresh and retry');
    this.name = 'MeetingVersionConflictError';
  }
}
// FIX_NOW-2 — the idempotency key was reused with a different tenant/organizer/
// Talent/Requisition than the operation it is bound to; never an authorized replay.
export class MeetingIdempotencyConflictError extends Error {
  constructor() {
    super('idempotency key is bound to a different scheduling request');
    this.name = 'MeetingIdempotencyConflictError';
  }
}
// FIX_NOW-2 — a concurrent attempt already holds this scheduling operation; the
// caller must not independently proceed (prevents a duplicate provider call).
export class MeetingOperationInProgressError extends Error {
  constructor() {
    super('a concurrent scheduling attempt is in progress for this key');
    this.name = 'MeetingOperationInProgressError';
  }
}
export class MeetingNotSchedulingError extends Error {
  constructor() {
    super('meeting is not an Outlook scheduling meeting');
    this.name = 'MeetingNotSchedulingError';
  }
}
export class TalentContactUnavailableError extends Error {
  constructor(readonly talent_record_id: string) {
    super('talent has no contactable email for an invitation');
    this.name = 'TalentContactUnavailableError';
  }
}

export interface ScheduleMeetingArgs {
  tenant_id: string;
  recruiter_id: string;
  connection_id?: string;
  talent_record_id: string;
  // INC-3 A1 Part F — null ONLY for a screening meeting with no Requisition.
  requisition_id: string | null;
  pipeline_id?: string;
  // INC-3 A1 Part F — a screening meeting: associates the screening session and
  // replaces the live-pipeline check with the screening association check.
  screening_session_id?: string;
  subject: string;
  start_date_time: string;
  end_date_time: string;
  time_zone: string;
  idempotency_key: string;
  authContext: AuthContextType;
  requestId: string;
}

export interface RescheduleMeetingArgs {
  tenant_id: string;
  recruiter_id: string;
  connection_id?: string;
  interaction_id: string;
  expected_version: number;
  start_date_time: string;
  end_date_time: string;
  time_zone: string;
  requestId: string;
}

export interface CancelMeetingArgs {
  tenant_id: string;
  recruiter_id: string;
  connection_id?: string;
  interaction_id: string;
  expected_version: number;
  comment?: string;
  requestId: string;
}

export interface ScheduledMeetingView {
  interaction_id: string;
  operation_id: string | null;
  provider_event_id: string | null;
  join_url: string | null;
  status: string;
  version: number;
  scheduled_start: string | null;
  scheduled_end: string | null;
  idempotent_replay: boolean;
}

@Injectable()
export class MicrosoftSchedulingService {
  constructor(
    private readonly delegated: DelegatedAuthorizationService,
    @Inject(MICROSOFT_CALENDAR_PORT) private readonly calendar: MicrosoftCalendarPort,
    @Inject(MICROSOFT_GRAPH_PORT) private readonly graph: MicrosoftGraphPort,
    private readonly repo: MeetingSchedulingRepository,
    private readonly config: MicrosoftConfigResolver,
    private readonly associations: MeetingAssociationValidator,
    @Inject(CALENDAR_INVITE_CONSENT_GATE) private readonly consent: CalendarInviteConsentGate,
    private readonly talents: TalentRecordRepository,
  ) {}

  async scheduleMeeting(args: ScheduleMeetingArgs): Promise<ScheduledMeetingView> {
    // Resolve the EFFECTIVE connection up front — it is part of the immutable request
    // identity the idempotency key is bound to (FIX-3).
    const connectionId = await this.config.resolveConnectionId(args.tenant_id, args.connection_id);
    const fingerprint = this.requestFingerprint(args, connectionId);

    // 1. Atomically CLAIM the durable operation — the single serialization +
    // idempotency + ownership gate (FIX_NOW-2). transaction_id = the client key:
    // stable across retries so a retried create carries the SAME Graph transactionId
    // and the provider de-dups rather than creating a twin.
    const claim = await this.repo.claimSchedulingOperation({
      tenant_id: args.tenant_id,
      idempotency_key: args.idempotency_key,
      transaction_id: args.idempotency_key,
      organizer_id: args.recruiter_id,
      talent_record_id: args.talent_record_id,
      requisition_id: args.requisition_id,
      request_fingerprint: fingerprint,
    });
    if (claim.outcome === 'identity_conflict') {
      throw new MeetingIdempotencyConflictError();
    }
    if (claim.outcome === 'in_progress') {
      throw new MeetingOperationInProgressError();
    }
    if (claim.outcome === 'needs_reconciliation') {
      // UNCERTAIN prior outcome (unresolved, or an abandoned pending): the provider
      // event may exist. NEVER auto-recreate — surface for bounded reconciliation (R3/FIX-4).
      throw new MeetingScheduleUnresolvedError(claim.op?.id ?? '');
    }
    if (claim.outcome === 'replay') {
      const existing =
        claim.op?.interaction_id != null
          ? await this.repo.findScheduledMeeting(args.tenant_id, claim.op.interaction_id)
          : null;
      if (existing !== null) {
        return this.view(existing, claim.op?.id ?? null, true);
      }
      throw new MeetingScheduleUnresolvedError(claim.op?.id ?? '');
    }
    // claim.outcome === 'created' → we exclusively own the pending operation.
    const op = claim.op;
    if (op === null) {
      throw new Error('scheduling claim returned created with no operation');
    }

    try {
      // Authorization + association (C-4) THEN consent (R1) — fail closed, BEFORE any
      // provider side-effect. Validation runs AFTER the claim so a stuck pending op
      // never results: any throw below marks the op failed/unresolved (reclaimable).
      if (args.screening_session_id !== undefined) {
        await this.associations.assertScreeningAssociation({
          tenant_id: args.tenant_id,
          talent_record_id: args.talent_record_id,
          requisition_id: args.requisition_id,
        });
      } else {
        if (args.requisition_id === null) {
          throw new MeetingAssociationError('association_invalid', `${args.talent_record_id}@none`);
        }
        await this.associations.assertRecruitingAssociation({
          tenant_id: args.tenant_id,
          talent_record_id: args.talent_record_id,
          requisition_id: args.requisition_id,
        });
      }
      await this.consent.assertInvitationAllowed({
        tenant_id: args.tenant_id,
        talent_record_id: args.talent_record_id,
        authContext: args.authContext,
        requestId: args.requestId,
      });

      const cfg = await this.config.resolveConfig(args.tenant_id, connectionId, true);
      const token = await this.delegated.getUsableAccessToken({
        tenant_id: args.tenant_id,
        connection_id: connectionId,
        recruiter_id: args.recruiter_id,
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        authorityTenant: cfg.authorityTenant,
        nowEpochSeconds: this.config.nowSeconds(),
      });
      const me = await this.graph.getMe(token.access_token);

      const contacts = await this.talents.findContactByIds(args.tenant_id, [args.talent_record_id]);
      const attendeeEmail = contacts.get(args.talent_record_id)?.email ?? null;
      if (attendeeEmail === null || attendeeEmail.length === 0) {
        throw new TalentContactUnavailableError(args.talent_record_id);
      }

      const event = await this.calendar.createCalendarEvent({
        accessToken: token.access_token,
        subject: args.subject,
        startDateTime: args.start_date_time,
        endDateTime: args.end_date_time,
        timeZone: args.time_zone,
        attendees: [{ email: attendeeEmail, type: 'required' }],
        isOnlineMeeting: true,
        transactionId: op.transaction_id,
      });

      const row = await this.repo.createScheduledMeeting({
        tenant_id: args.tenant_id,
        integration_connection_id: connectionId,
        organizer_id: args.recruiter_id,
        from_address: me.user_principal_name,
        to_address: attendeeEmail,
        provider_event_id: event.provider_event_id,
        join_reference: event.join_url ?? null,
        started_at: new Date(args.start_date_time),
        ended_at: new Date(args.end_date_time),
        subject: args.subject,
        talent_record_id: args.talent_record_id,
        requisition_id: args.requisition_id,
        pipeline_id: args.pipeline_id,
        screening_session_id: args.screening_session_id ?? null,
      });
      await this.repo.markOperation(op.id, {
        status: 'succeeded',
        provider_event_id: event.provider_event_id,
        interaction_id: row.id,
      });
      await this.repo.writeAudit({
        tenant_id: args.tenant_id,
        actor_id: args.recruiter_id,
        actor_type: 'recruiter',
        event_type: 'meeting.scheduled',
        interaction_id: row.id,
        operation_id: op.id,
        provider_event_id: event.provider_event_id,
        talent_record_id: args.talent_record_id,
        requisition_id: args.requisition_id,
        outcome: 'succeeded',
        event_payload: { start: args.start_date_time, end: args.end_date_time, time_zone: args.time_zone },
      });
      return this.view(row, op.id, false);
    } catch (err) {
      if (err instanceof GraphCalendarError && err.ambiguous) {
        // Outcome UNKNOWN — durable unresolved state; a retry RECLAIMS it and
        // re-attempts with the SAME transactionId (provider de-dup). Never blind-recreate.
        await this.repo.markOperation(op.id, { status: 'unresolved', last_error: err.message });
        await this.repo.writeAudit({
          tenant_id: args.tenant_id,
          actor_id: args.recruiter_id,
          actor_type: 'recruiter',
          event_type: 'meeting.provider_failed',
          operation_id: op.id,
          talent_record_id: args.talent_record_id,
          requisition_id: args.requisition_id,
          outcome: 'unresolved',
          event_payload: { kind: err.kind, status: err.status },
        });
        throw new MeetingScheduleUnresolvedError(op.id);
      }
      // Any other failure (association / consent / token / email / deterministic
      // provider): mark the operation FAILED so a corrected retry can RECLAIM it —
      // never a stuck pending op. Provider errors also leave a forensic audit.
      await this.repo.markOperation(op.id, {
        status: 'failed',
        last_error: err instanceof Error ? err.message : 'scheduling failed',
      });
      if (err instanceof GraphCalendarError) {
        await this.repo.writeAudit({
          tenant_id: args.tenant_id,
          actor_id: args.recruiter_id,
          actor_type: 'recruiter',
          event_type: 'meeting.provider_failed',
          operation_id: op.id,
          talent_record_id: args.talent_record_id,
          requisition_id: args.requisition_id,
          outcome: 'failed',
          event_payload: { kind: err.kind, status: err.status },
        });
      }
      throw err;
    }
  }

  async rescheduleMeeting(args: RescheduleMeetingArgs): Promise<ScheduledMeetingView> {
    const row = await this.loadMutableMeeting(args.tenant_id, args.interaction_id, args.recruiter_id);
    // FIX_NOW-1 — RESERVE (atomic version CAS) BEFORE any Graph side effect. A stale
    // or concurrent request loses the version race here and NEVER touches Outlook.
    const reserve = await this.repo.reserveMutationCas({
      tenant_id: args.tenant_id,
      interaction_id: args.interaction_id,
      expected_version: args.expected_version,
      now: new Date(),
      // Durable intent (PR#918 reconciliation pass): the intended target window, so a
      // later reconcile can verify the provider actually moved to it (not merely exists).
      mutation: 'reschedule',
      target_start: new Date(args.start_date_time),
      target_end: new Date(args.end_date_time),
    });
    if (reserve.conflict) {
      throw new MeetingVersionConflictError();
    }
    const token = await this.organizerToken(args.tenant_id, args.recruiter_id, args.connection_id);
    try {
      await this.calendar.updateCalendarEvent({
        accessToken: token,
        providerEventId: row.provider_event_id as string,
        startDateTime: args.start_date_time,
        endDateTime: args.end_date_time,
        timeZone: args.time_zone,
      });
    } catch (err) {
      // Graph failed AFTER the reservation — do NOT claim success. The fence stays
      // held (row at reserved_version, status unchanged) as a durable, inspectable
      // state for bounded reconciliation; no automatic retry.
      await this.recordMutationProviderFailure(args.tenant_id, args.recruiter_id, row, 'reschedule', err);
      if (err instanceof GraphCalendarError && err.ambiguous) {
        throw new MeetingScheduleUnresolvedError(row.id);
      }
      throw err;
    }
    // CHECKED finalize (FIX-2): if persistence did not land, the outcome is uncertain —
    // the fence stays held, NO success audit is emitted, and we surface for reconciliation.
    const fin = await this.repo.finalizeReschedule({
      tenant_id: args.tenant_id,
      interaction_id: args.interaction_id,
      reserved_version: reserve.reserved_version,
      started_at: new Date(args.start_date_time),
      ended_at: new Date(args.end_date_time),
    });
    if (!fin.ok) {
      await this.recordMutationProviderFailure(
        args.tenant_id, args.recruiter_id, row, 'reschedule',
        new GraphCalendarError('transient', 0, 'finalize did not land', undefined, true),
      );
      throw new MeetingScheduleUnresolvedError(row.id);
    }
    await this.repo.writeAudit({
      tenant_id: args.tenant_id,
      actor_id: args.recruiter_id,
      actor_type: 'recruiter',
      event_type: 'meeting.rescheduled',
      interaction_id: row.id,
      provider_event_id: row.provider_event_id,
      outcome: 'succeeded',
      event_payload: { start: args.start_date_time, end: args.end_date_time, time_zone: args.time_zone },
    });
    const updated = await this.repo.findScheduledMeeting(args.tenant_id, args.interaction_id);
    return this.view(updated ?? row, null, false);
  }

  async cancelMeeting(args: CancelMeetingArgs): Promise<ScheduledMeetingView> {
    const row = await this.loadMutableMeeting(args.tenant_id, args.interaction_id, args.recruiter_id, true);
    // Idempotent: an already-cancelled meeting is a stable end state — no reservation,
    // no provider call, no duplicate audit (regardless of expected_version).
    if (row.status === 'cancelled') {
      return this.view(row, null, true);
    }
    // FIX_NOW-1 — RESERVE before the Graph cancel. Stale/concurrent → conflict, NO Graph.
    const reserve = await this.repo.reserveMutationCas({
      tenant_id: args.tenant_id,
      interaction_id: args.interaction_id,
      expected_version: args.expected_version,
      now: new Date(),
      // Durable intent (PR#918 reconciliation pass): a cancel is confirmed only when the
      // provider event is absent/cancelled — no target window to match.
      mutation: 'cancel',
    });
    if (reserve.conflict) {
      throw new MeetingVersionConflictError();
    }
    const token = await this.organizerToken(args.tenant_id, args.recruiter_id, args.connection_id);
    try {
      await this.calendar.cancelCalendarEvent({
        accessToken: token,
        providerEventId: row.provider_event_id as string,
        comment: args.comment,
      });
    } catch (err) {
      await this.recordMutationProviderFailure(args.tenant_id, args.recruiter_id, row, 'cancel', err);
      if (err instanceof GraphCalendarError && err.ambiguous) {
        throw new MeetingScheduleUnresolvedError(row.id);
      }
      throw err;
    }
    // CHECKED finalize (FIX-2): never emit a success audit on a zero-row finalize.
    const fin = await this.repo.finalizeCancel({
      tenant_id: args.tenant_id,
      interaction_id: args.interaction_id,
      reserved_version: reserve.reserved_version,
    });
    if (!fin.ok) {
      await this.recordMutationProviderFailure(
        args.tenant_id, args.recruiter_id, row, 'cancel',
        new GraphCalendarError('transient', 0, 'finalize did not land', undefined, true),
      );
      throw new MeetingScheduleUnresolvedError(row.id);
    }
    await this.repo.writeAudit({
      tenant_id: args.tenant_id,
      actor_id: args.recruiter_id,
      actor_type: 'recruiter',
      event_type: 'meeting.cancelled',
      interaction_id: row.id,
      provider_event_id: row.provider_event_id,
      outcome: 'succeeded',
      event_payload: {},
    });
    const updated = await this.repo.findScheduledMeeting(args.tenant_id, args.interaction_id);
    return this.view(updated ?? row, null, false);
  }

  /** Durable forensic record of a post-reservation provider failure (reschedule/cancel). */
  private async recordMutationProviderFailure(
    tenant_id: string,
    recruiter_id: string,
    row: ScheduledMeetingRow,
    operation: 'reschedule' | 'cancel',
    err: unknown,
  ): Promise<void> {
    await this.repo.writeAudit({
      tenant_id,
      actor_id: recruiter_id,
      actor_type: 'recruiter',
      event_type: 'meeting.provider_failed',
      interaction_id: row.id,
      provider_event_id: row.provider_event_id,
      outcome: err instanceof GraphCalendarError && err.ambiguous ? 'unresolved' : 'failed',
      event_payload: {
        operation,
        kind: err instanceof GraphCalendarError ? err.kind : 'error',
        status: err instanceof GraphCalendarError ? err.status : 0,
      },
    });
  }

  async readMeeting(tenant_id: string, interaction_id: string): Promise<ScheduledMeetingView | null> {
    const row = await this.repo.findScheduledMeeting(tenant_id, interaction_id);
    return row === null ? null : this.view(row, null, false);
  }

  /**
   * Bounded, EXPLICIT recovery (FIX-4 + PR#918 reconciliation pass) for a mutation whose
   * fence is held but whose provider outcome was uncertain (Graph failure after
   * reservation, or an abandoned mutation). Reads the provider event (Outlook is source
   * of truth) and releases the fence ONLY to the outcome the provider actually confirms
   * against the RECORDED intent: a reschedule requires a present event at the intended
   * window; a cancel requires an absent/cancelled event. An inconclusive lookup, an
   * unconfirmed provider state, or a finalize that did not land all keep the fence +
   * unresolved — a missing/uncertain response is never read as a confirmed cancellation.
   * Organizer-bound (R2), tenant-scoped; never an automatic provider re-issue. (A
   * create-side `unresolved`/abandoned-`pending` op carries no event id and is reconciled
   * operationally, not here.)
   */
  async reconcileMeeting(args: {
    tenant_id: string;
    recruiter_id: string;
    interaction_id: string;
    connection_id?: string;
  }): Promise<ScheduledMeetingView> {
    const row = await this.repo.findScheduledMeeting(args.tenant_id, args.interaction_id);
    if (row === null) {
      throw new MeetingNotFoundError();
    }
    if (row.initiated_by_id !== args.recruiter_id) {
      throw new MeetingOrganizerMismatchError();
    }
    if (row.mutation_locked_at === null) {
      return this.view(row, null, false); // not fenced — nothing to reconcile
    }
    if (row.provider_event_id === null || row.provider_event_id.length === 0) {
      throw new MeetingNotSchedulingError();
    }
    const token = await this.organizerToken(args.tenant_id, args.recruiter_id, args.connection_id);

    // Read provider truth. `getCalendarEvent` returns null ONLY on an authoritative 404
    // (event absent); every inconclusive case (reauth/forbidden/throttled-exhausted/
    // transient/network) THROWS. An inconclusive lookup means the provider outcome
    // CANNOT be established — preserve the fence + unresolved; never guess (R3/R6).
    let ev: GraphEventResult | null;
    try {
      ev = await this.calendar.getCalendarEvent({ accessToken: token, providerEventId: row.provider_event_id });
    } catch (err) {
      await this.writeReconcileUnresolved(args.tenant_id, args.recruiter_id, row, 'lookup_inconclusive', err);
      throw new MeetingScheduleUnresolvedError(row.id);
    }

    // Verify the ACTUAL provider state against the RECORDED mutation intent before
    // releasing the fence. null = the intended mutation is NOT confirmed (a reschedule
    // whose window did not land, a cancel whose event is still active, or an absent/
    // cancelled event for a reschedule). A missing/inconclusive response is NEVER read
    // as a confirmed cancellation.
    const resolved = this.resolveProviderOutcome(row, ev);
    if (resolved === null) {
      await this.writeReconcileUnresolved(args.tenant_id, args.recruiter_id, row, 'provider_state_unconfirmed');
      throw new MeetingScheduleUnresolvedError(row.id);
    }

    // CHECKED release (FIX-2 parity): only emit a success audit if the reconcile write
    // actually landed on the row we still hold; otherwise the state is uncertain — keep
    // the fence + unresolved, no success audit.
    const rec = await this.repo.reconcileLockedMutation({
      tenant_id: args.tenant_id,
      interaction_id: args.interaction_id,
      resolved_status: resolved,
    });
    if (!rec.ok) {
      await this.writeReconcileUnresolved(args.tenant_id, args.recruiter_id, row, 'finalize_did_not_land');
      throw new MeetingScheduleUnresolvedError(row.id);
    }
    await this.repo.writeAudit({
      tenant_id: args.tenant_id,
      actor_id: args.recruiter_id,
      actor_type: 'recruiter',
      event_type: 'meeting.reconciled',
      interaction_id: row.id,
      provider_event_id: row.provider_event_id,
      outcome: 'succeeded',
      event_payload: { resolved },
    });
    const updated = await this.repo.findScheduledMeeting(args.tenant_id, args.interaction_id);
    return this.view(updated ?? row, null, false);
  }

  /**
   * Map the RECORDED mutation intent + the AUTHORITATIVE provider event to a confirmed
   * terminal outcome, or null when the provider does NOT confirm the intended mutation.
   * `ev === null` is an authoritative 404 (absent); inconclusive lookups never reach
   * here (they throw in the caller). A cancellation is never inferred from uncertainty.
   */
  private resolveProviderOutcome(
    row: ScheduledMeetingRow,
    ev: GraphEventResult | null,
  ): 'rescheduled' | 'cancelled' | null {
    if (row.pending_mutation === 'cancel') {
      // Confirmed ONLY when the provider event is absent or marked cancelled.
      return ev === null || ev.status === 'cancelled' ? 'cancelled' : null;
    }
    if (row.pending_mutation === 'reschedule') {
      // Confirmed ONLY by a present, non-cancelled event whose window matches the
      // intended target. Absent/cancelled, or a different window, is NOT a reschedule.
      if (ev === null || ev.status === 'cancelled') {
        return null;
      }
      return this.providerWindowMatches(row, ev) ? 'rescheduled' : null;
    }
    // No recorded intent (a pre-intent abandoned fence): only an authoritative
    // absence/cancellation is a safe terminal resolution.
    return ev === null || ev.status === 'cancelled' ? 'cancelled' : null;
  }

  /** True iff the provider event's window equals the intended reschedule target. */
  private providerWindowMatches(row: ScheduledMeetingRow, ev: GraphEventResult): boolean {
    if (row.pending_start === null || row.pending_end === null) {
      return false; // a reschedule intent with no recorded window cannot be verified
    }
    const evStart = Date.parse(ev.start_date_time);
    const evEnd = Date.parse(ev.end_date_time);
    if (Number.isNaN(evStart) || Number.isNaN(evEnd)) {
      return false; // provider window unparseable → cannot confirm
    }
    return evStart === row.pending_start.getTime() && evEnd === row.pending_end.getTime();
  }

  /** Durable unresolved audit for a reconcile that could not confirm provider truth. */
  private async writeReconcileUnresolved(
    tenant_id: string,
    recruiter_id: string,
    row: ScheduledMeetingRow,
    reason: 'lookup_inconclusive' | 'provider_state_unconfirmed' | 'finalize_did_not_land',
    err?: unknown,
  ): Promise<void> {
    await this.repo.writeAudit({
      tenant_id,
      actor_id: recruiter_id,
      actor_type: 'recruiter',
      event_type: 'meeting.provider_failed',
      interaction_id: row.id,
      provider_event_id: row.provider_event_id,
      outcome: 'unresolved',
      event_payload: {
        operation: 'reconcile',
        reason,
        intent: row.pending_mutation,
        kind: err instanceof GraphCalendarError ? err.kind : undefined,
        status: err instanceof GraphCalendarError ? err.status : undefined,
      },
    });
  }

  private requestFingerprint(args: ScheduleMeetingArgs, effectiveConnectionId: string): string {
    // Pipe-joined immutable request identity (FIX-3). '|' (never a space → NUL trap).
    // The recruiting-meeting format is UNCHANGED (an op persisted before INC-3 A1
    // must still match its own retry); only a screening meeting (A1 Part F)
    // appends its session — and only it may carry a null Requisition.
    const base = [
      args.recruiter_id,
      args.talent_record_id,
      args.requisition_id ?? '',
      args.subject,
      args.start_date_time,
      args.end_date_time,
      args.time_zone,
      effectiveConnectionId,
    ].join('|');
    return args.screening_session_id === undefined ? base : `${base}|screening:${args.screening_session_id}`;
  }

  async listUpcoming(args: {
    tenant_id: string;
    talent_record_id?: string;
    requisition_id?: string;
    from: Date;
    to: Date;
  }): Promise<ScheduledMeetingView[]> {
    const rows = await this.repo.listUpcomingMeetings(args);
    return rows.map((r) => this.view(r, null, false));
  }

  /** Load a meeting for mutation: tenant-scoped, organizer-bound (R2), scheduling-only. */
  private async loadMutableMeeting(
    tenant_id: string,
    interaction_id: string,
    recruiter_id: string,
    allowCancelled = false,
  ): Promise<ScheduledMeetingRow> {
    const row = await this.repo.findScheduledMeeting(tenant_id, interaction_id);
    if (row === null) {
      throw new MeetingNotFoundError();
    }
    // Organizer-bound: a scope alone never authorizes mutating another recruiter's
    // meeting (R2). Tenant isolation is already enforced by the tenant-scoped read.
    if (row.initiated_by_id !== recruiter_id) {
      throw new MeetingOrganizerMismatchError();
    }
    if (row.provider_event_id === null || row.provider_event_id.length === 0) {
      // A create-link-only meeting is not an Outlook scheduling event.
      throw new MeetingNotSchedulingError();
    }
    if (!allowCancelled && row.status === 'cancelled') {
      throw new MeetingVersionConflictError();
    }
    return row;
  }

  private async organizerToken(
    tenant_id: string,
    recruiter_id: string,
    connection_id?: string,
  ): Promise<string> {
    const connectionId = await this.config.resolveConnectionId(tenant_id, connection_id);
    const cfg = await this.config.resolveConfig(tenant_id, connectionId, true);
    const token = await this.delegated.getUsableAccessToken({
      tenant_id,
      connection_id: connectionId,
      recruiter_id,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      authorityTenant: cfg.authorityTenant,
      nowEpochSeconds: this.config.nowSeconds(),
    });
    return token.access_token;
  }

  private view(row: ScheduledMeetingRow, operation_id: string | null, replay: boolean): ScheduledMeetingView {
    return {
      interaction_id: row.id,
      operation_id,
      provider_event_id: row.provider_event_id,
      join_url: row.join_reference,
      status: row.status,
      version: row.version,
      scheduled_start: row.started_at?.toISOString() ?? null,
      scheduled_end: row.ended_at?.toISOString() ?? null,
      idempotent_replay: replay,
    };
  }
}
