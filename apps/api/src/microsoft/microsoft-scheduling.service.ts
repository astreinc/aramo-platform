import { Inject, Injectable } from '@nestjs/common';
import type { AuthContextType } from '@aramo/auth';
import {
  MeetingSchedulingRepository,
  type ScheduledMeetingRow,
} from '@aramo/communications';
import {
  DelegatedAuthorizationService,
  GraphCalendarError,
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
import { MeetingAssociationValidator } from './meeting-association.validator.js';
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
  requisition_id: string;
  pipeline_id?: string;
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
    // Idempotent replay: a succeeded operation returns its existing meeting WITHOUT
    // re-validating, re-contacting, or re-creating a provider event.
    const prior = await this.repo.findOperation(args.tenant_id, args.idempotency_key);
    if (prior !== null && prior.status === 'succeeded' && prior.interaction_id !== null) {
      const row = await this.repo.findScheduledMeeting(args.tenant_id, prior.interaction_id);
      if (row !== null) {
        return this.view(row, prior.id, true);
      }
    }

    // Authorization + association (C-4) THEN consent (R1) — both fail closed, both
    // BEFORE any durable intent or provider side-effect.
    await this.associations.assertRecruitingAssociation({
      tenant_id: args.tenant_id,
      talent_record_id: args.talent_record_id,
      requisition_id: args.requisition_id,
    });
    await this.consent.assertInvitationAllowed({
      tenant_id: args.tenant_id,
      talent_record_id: args.talent_record_id,
      authContext: args.authContext,
      requestId: args.requestId,
    });

    const connectionId = await this.config.resolveConnectionId(args.tenant_id, args.connection_id);
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

    // Durable intent BEFORE the Graph call (R3). transaction_id = the client
    // idempotency key: stable across retries, so a retried create carries the SAME
    // Graph transactionId and the provider de-dups rather than creating a twin.
    const { op } = await this.repo.createOrGetOperation({
      tenant_id: args.tenant_id,
      idempotency_key: args.idempotency_key,
      transaction_id: args.idempotency_key,
      organizer_id: args.recruiter_id,
      talent_record_id: args.talent_record_id,
      requisition_id: args.requisition_id,
    });

    let event;
    try {
      event = await this.calendar.createCalendarEvent({
        accessToken: token.access_token,
        subject: args.subject,
        startDateTime: args.start_date_time,
        endDateTime: args.end_date_time,
        timeZone: args.time_zone,
        attendees: [{ email: attendeeEmail, type: 'required' }],
        isOnlineMeeting: true,
        transactionId: op.transaction_id,
      });
    } catch (err) {
      if (err instanceof GraphCalendarError && err.ambiguous) {
        // Outcome UNKNOWN — record the explicit unresolved state and STOP. A retry
        // re-attempts with the SAME transactionId (provider de-dup); never blind-recreate.
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
      // Deterministic failure (reauth / forbidden / throttled / permanent): no
      // provider event was created. Mark failed, audit, rethrow (controller maps).
      await this.repo.markOperation(op.id, {
        status: 'failed',
        last_error: err instanceof Error ? err.message : 'graph error',
      });
      await this.repo.writeAudit({
        tenant_id: args.tenant_id,
        actor_id: args.recruiter_id,
        actor_type: 'recruiter',
        event_type: 'meeting.provider_failed',
        operation_id: op.id,
        talent_record_id: args.talent_record_id,
        requisition_id: args.requisition_id,
        outcome: 'failed',
        event_payload: {
          kind: err instanceof GraphCalendarError ? err.kind : 'error',
          status: err instanceof GraphCalendarError ? err.status : 0,
        },
      });
      throw err;
    }

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
  }

  async rescheduleMeeting(args: RescheduleMeetingArgs): Promise<ScheduledMeetingView> {
    const row = await this.loadMutableMeeting(args.tenant_id, args.interaction_id, args.recruiter_id);
    const token = await this.organizerToken(args.tenant_id, args.recruiter_id, args.connection_id);

    await this.calendar.updateCalendarEvent({
      accessToken: token,
      providerEventId: row.provider_event_id as string,
      startDateTime: args.start_date_time,
      endDateTime: args.end_date_time,
      timeZone: args.time_zone,
    });

    const cas = await this.repo.rescheduleMeetingCas({
      tenant_id: args.tenant_id,
      interaction_id: args.interaction_id,
      expected_version: args.expected_version,
      started_at: new Date(args.start_date_time),
      ended_at: new Date(args.end_date_time),
    });
    if (cas.conflict) {
      throw new MeetingVersionConflictError();
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
    // Idempotent: an already-cancelled meeting is a stable end state — no provider
    // call, no duplicate audit.
    if (row.status === 'cancelled') {
      return this.view(row, null, true);
    }
    const token = await this.organizerToken(args.tenant_id, args.recruiter_id, args.connection_id);
    await this.calendar.cancelCalendarEvent({
      accessToken: token,
      providerEventId: row.provider_event_id as string,
      comment: args.comment,
    });
    const cas = await this.repo.cancelMeetingCas({
      tenant_id: args.tenant_id,
      interaction_id: args.interaction_id,
      expected_version: args.expected_version,
    });
    if (cas.alreadyCancelled) {
      return this.view(row, null, true);
    }
    if (cas.conflict) {
      throw new MeetingVersionConflictError();
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

  async readMeeting(tenant_id: string, interaction_id: string): Promise<ScheduledMeetingView | null> {
    const row = await this.repo.findScheduledMeeting(tenant_id, interaction_id);
    return row === null ? null : this.view(row, null, false);
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
