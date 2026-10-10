import { GraphCalendarError } from '@aramo/microsoft-graph';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MeetingOrganizerMismatchError,
  MeetingScheduleUnresolvedError,
  MeetingVersionConflictError,
  MicrosoftSchedulingService,
  type CancelMeetingArgs,
  type RescheduleMeetingArgs,
  type ScheduleMeetingArgs,
} from '../microsoft/microsoft-scheduling.service.js';

// COMM-C2B Amendment A1 (M365-SCHED-1) — service orchestration proofs (fakes, no DB):
// durable intent BEFORE Graph, transactionId provider-dedup, ambiguous→unresolved with
// NO duplicate creation (R3), consent+association gating BEFORE side-effects (R1/C-4),
// organizer-bound mutation (R2), CAS conflict (R3), idempotent replay + cancel.

const TENANT = 't-1';
const RECRUITER = 'r-1';
const TALENT = 'tal-1';
const REQ = 'req-1';

function build(overrides: {
  calendar?: Record<string, unknown>;
  repo?: Record<string, unknown>;
  validator?: Record<string, unknown>;
  consent?: Record<string, unknown>;
  findOperation?: unknown;
  findScheduledMeeting?: unknown;
}) {
  const calls = {
    createCalendarEvent: vi.fn().mockResolvedValue({
      provider_event_id: 'evt-1',
      join_url: 'https://teams/join',
      start_date_time: 's',
      end_date_time: 'e',
    }),
    updateCalendarEvent: vi.fn().mockResolvedValue({ provider_event_id: 'evt-1', start_date_time: 's', end_date_time: 'e' }),
    cancelCalendarEvent: vi.fn().mockResolvedValue(undefined),
    getCalendarEvent: vi.fn().mockResolvedValue(null),
    ...overrides.calendar,
  };
  const repoCalls = {
    findOperation: vi.fn().mockResolvedValue(overrides.findOperation ?? null),
    createOrGetOperation: vi.fn().mockResolvedValue({ op: { id: 'op-1', transaction_id: 'idem-1' }, created: true }),
    markOperation: vi.fn().mockResolvedValue(undefined),
    createScheduledMeeting: vi.fn().mockResolvedValue({
      id: 'int-1', tenant_id: TENANT, status: 'scheduled', version: 0,
      provider_event_id: 'evt-1', join_reference: 'https://teams/join', initiated_by_id: RECRUITER,
      started_at: new Date('2026-11-01T10:00:00Z'), ended_at: new Date('2026-11-01T10:30:00Z'),
    }),
    findScheduledMeeting: vi.fn().mockResolvedValue(overrides.findScheduledMeeting ?? null),
    rescheduleMeetingCas: vi.fn().mockResolvedValue({ conflict: false }),
    cancelMeetingCas: vi.fn().mockResolvedValue({ conflict: false, alreadyCancelled: false }),
    listUpcomingMeetings: vi.fn().mockResolvedValue([]),
    writeAudit: vi.fn().mockResolvedValue(undefined),
    ...overrides.repo,
  };
  const validator = {
    assertTenantOwnership: vi.fn().mockResolvedValue(undefined),
    assertRecruitingAssociation: vi.fn().mockResolvedValue(undefined),
    ...overrides.validator,
  };
  const consent = {
    assertInvitationAllowed: vi.fn().mockResolvedValue(undefined),
    ...overrides.consent,
  };
  const delegated = { getUsableAccessToken: vi.fn().mockResolvedValue({ access_token: 'tok' }) };
  const graph = { getMe: vi.fn().mockResolvedValue({ user_principal_name: 'r@x.com' }) };
  const config = {
    resolveConnectionId: vi.fn().mockResolvedValue('conn-1'),
    resolveConfig: vi.fn().mockResolvedValue({ clientId: 'c', clientSecret: 's' }),
    nowSeconds: () => 1_000_000,
  };
  const talents = {
    findContactByIds: vi.fn().mockResolvedValue(new Map([[TALENT, { email: 'tal@x.com' }]])),
  };
  const svc = new MicrosoftSchedulingService(
    delegated as never,
    calls as never,
    graph as never,
    repoCalls as never,
    config as never,
    validator as never,
    consent as never,
    talents as never,
  );
  return { svc, calls, repoCalls, validator, consent, delegated, graph, talents };
}

const scheduleArgs: ScheduleMeetingArgs = {
  tenant_id: TENANT, recruiter_id: RECRUITER, talent_record_id: TALENT, requisition_id: REQ,
  subject: 'Screen', start_date_time: '2026-11-01T10:00:00', end_date_time: '2026-11-01T10:30:00',
  time_zone: 'America/New_York', idempotency_key: 'idem-1',
  authContext: {} as never, requestId: 'rq-1',
};

afterEach(() => vi.restoreAllMocks());

describe('MicrosoftSchedulingService.scheduleMeeting (A1 R1/R3/C-4)', () => {
  it('validates association, enforces consent, writes durable intent, then creates with transactionId', async () => {
    const { svc, calls, repoCalls, validator, consent } = build({});
    const view = await svc.scheduleMeeting(scheduleArgs);

    expect(validator.assertRecruitingAssociation).toHaveBeenCalledOnce();
    expect(consent.assertInvitationAllowed).toHaveBeenCalledOnce();
    // Durable op created BEFORE the Graph call.
    expect(repoCalls.createOrGetOperation).toHaveBeenCalledOnce();
    const createArg = calls.createCalendarEvent.mock.calls[0][0] as { transactionId: string; attendees: unknown[]; isOnlineMeeting: boolean };
    expect(createArg.transactionId).toBe('idem-1'); // stable provider-dedup guard
    expect(createArg.isOnlineMeeting).toBe(true);
    expect(createArg.attendees).toEqual([{ email: 'tal@x.com', type: 'required' }]);
    expect(repoCalls.markOperation).toHaveBeenCalledWith('op-1', expect.objectContaining({ status: 'succeeded' }));
    expect(view.status).toBe('scheduled');
    expect(view.idempotent_replay).toBe(false);
  });

  it('on an AMBIGUOUS Graph outcome marks the operation unresolved and creates NO meeting (R3)', async () => {
    const ambiguous = new GraphCalendarError('transient', 503, 'timeout', undefined, true);
    const { svc, repoCalls } = build({ calendar: { createCalendarEvent: vi.fn().mockRejectedValue(ambiguous) } });

    await expect(svc.scheduleMeeting(scheduleArgs)).rejects.toBeInstanceOf(MeetingScheduleUnresolvedError);
    expect(repoCalls.markOperation).toHaveBeenCalledWith('op-1', expect.objectContaining({ status: 'unresolved' }));
    // NO blind duplicate: the meeting evidence row is never written on ambiguity.
    expect(repoCalls.createScheduledMeeting).not.toHaveBeenCalled();
  });

  it('fails closed on an invalid recruiting association BEFORE consent / intent / Graph', async () => {
    const { svc, consent, repoCalls, calls } = build({
      validator: { assertRecruitingAssociation: vi.fn().mockRejectedValue(new Error('assoc')) },
    });
    await expect(svc.scheduleMeeting(scheduleArgs)).rejects.toThrow();
    expect(consent.assertInvitationAllowed).not.toHaveBeenCalled();
    expect(repoCalls.createOrGetOperation).not.toHaveBeenCalled();
    expect(calls.createCalendarEvent).not.toHaveBeenCalled();
  });

  it('fails closed on missing/stale consent BEFORE intent / Graph', async () => {
    const { svc, repoCalls, calls } = build({
      consent: { assertInvitationAllowed: vi.fn().mockRejectedValue(new Error('consent')) },
    });
    await expect(svc.scheduleMeeting(scheduleArgs)).rejects.toThrow();
    expect(repoCalls.createOrGetOperation).not.toHaveBeenCalled();
    expect(calls.createCalendarEvent).not.toHaveBeenCalled();
  });

  it('idempotent replay of a succeeded operation returns the existing meeting without re-contacting', async () => {
    const { svc, calls, validator, consent } = build({
      findOperation: { id: 'op-1', status: 'succeeded', interaction_id: 'int-1', transaction_id: 'idem-1' },
      findScheduledMeeting: {
        id: 'int-1', tenant_id: TENANT, status: 'scheduled', version: 0, provider_event_id: 'evt-1',
        join_reference: 'j', initiated_by_id: RECRUITER, started_at: new Date(), ended_at: new Date(),
      },
    });
    const view = await svc.scheduleMeeting(scheduleArgs);
    expect(view.idempotent_replay).toBe(true);
    expect(validator.assertRecruitingAssociation).not.toHaveBeenCalled();
    expect(consent.assertInvitationAllowed).not.toHaveBeenCalled();
    expect(calls.createCalendarEvent).not.toHaveBeenCalled();
  });
});

describe('MicrosoftSchedulingService reschedule/cancel (A1 R2/R3)', () => {
  const activeMeeting = {
    id: 'int-1', tenant_id: TENANT, status: 'scheduled', version: 2, provider_event_id: 'evt-1',
    join_reference: 'j', initiated_by_id: RECRUITER, started_at: new Date(), ended_at: new Date(),
  };
  const reArgs: RescheduleMeetingArgs = {
    tenant_id: TENANT, recruiter_id: RECRUITER, interaction_id: 'int-1', expected_version: 2,
    start_date_time: '2026-11-02T10:00:00', end_date_time: '2026-11-02T10:30:00', time_zone: 'UTC', requestId: 'rq',
  };

  it('reschedule updates the SAME provider event then CAS-advances; audits', async () => {
    const { svc, calls, repoCalls } = build({ findScheduledMeeting: activeMeeting });
    await svc.rescheduleMeeting(reArgs);
    expect(calls.updateCalendarEvent.mock.calls[0][0]).toMatchObject({ providerEventId: 'evt-1' });
    expect(repoCalls.rescheduleMeetingCas).toHaveBeenCalledWith(expect.objectContaining({ expected_version: 2 }));
    expect(repoCalls.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'meeting.rescheduled' }));
  });

  it('refuses reschedule by a non-organizer (R2) before any Graph call', async () => {
    const { svc, calls } = build({ findScheduledMeeting: { ...activeMeeting, initiated_by_id: 'other' } });
    await expect(svc.rescheduleMeeting(reArgs)).rejects.toBeInstanceOf(MeetingOrganizerMismatchError);
    expect(calls.updateCalendarEvent).not.toHaveBeenCalled();
  });

  it('propagates a CAS version conflict as a 409-class error', async () => {
    const { svc } = build({
      findScheduledMeeting: activeMeeting,
      repo: { rescheduleMeetingCas: vi.fn().mockResolvedValue({ conflict: true }) },
    });
    await expect(svc.rescheduleMeeting(reArgs)).rejects.toBeInstanceOf(MeetingVersionConflictError);
  });

  it('cancel of an already-cancelled meeting is an idempotent no-op (no provider call)', async () => {
    const { svc, calls } = build({ findScheduledMeeting: { ...activeMeeting, status: 'cancelled' } });
    const cancelArgs: CancelMeetingArgs = {
      tenant_id: TENANT, recruiter_id: RECRUITER, interaction_id: 'int-1', expected_version: 2, requestId: 'rq',
    };
    const view = await svc.cancelMeeting(cancelArgs);
    expect(view.idempotent_replay).toBe(true);
    expect(calls.cancelCalendarEvent).not.toHaveBeenCalled();
  });
});
