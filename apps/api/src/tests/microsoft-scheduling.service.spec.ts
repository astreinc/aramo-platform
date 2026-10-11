import { GraphCalendarError } from '@aramo/microsoft-graph';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MeetingIdempotencyConflictError,
  MeetingOperationInProgressError,
  MeetingOrganizerMismatchError,
  MeetingScheduleUnresolvedError,
  MeetingVersionConflictError,
  MicrosoftSchedulingService,
  type CancelMeetingArgs,
  type RescheduleMeetingArgs,
  type ScheduleMeetingArgs,
} from '../microsoft/microsoft-scheduling.service.js';
import { MeetingAssociationError } from '../microsoft/meeting-association.validator.js';

// COMM-C2B Amendment A1 (M365-SCHED-1) — service orchestration proofs (fakes, no DB).
// Post-review (FIX_NOW-1/2): claim-based idempotency/ownership/concurrency gate, and
// RESERVE-before-Graph for reschedule/cancel so a stale/concurrent request never
// mutates Outlook. Consent + association still gate BEFORE any provider side-effect.

const TENANT = 't-1';
const RECRUITER = 'r-1';
const TALENT = 'tal-1';
const REQ = 'req-1';

const activeMeeting = {
  id: 'int-1', tenant_id: TENANT, status: 'scheduled', version: 2, provider_event_id: 'evt-1',
  join_reference: 'j', initiated_by_id: RECRUITER, started_at: new Date(), ended_at: new Date(),
};

function build(overrides: {
  claim?: unknown;
  reserve?: unknown;
  finalize?: unknown;
  calendar?: Record<string, unknown>;
  validator?: Record<string, unknown>;
  consent?: Record<string, unknown>;
  findScheduledMeeting?: unknown;
}) {
  const calendar = {
    createCalendarEvent: vi.fn().mockResolvedValue({ provider_event_id: 'evt-1', join_url: 'https://teams/join', start_date_time: 's', end_date_time: 'e' }),
    updateCalendarEvent: vi.fn().mockResolvedValue({ provider_event_id: 'evt-1', start_date_time: 's', end_date_time: 'e' }),
    cancelCalendarEvent: vi.fn().mockResolvedValue(undefined),
    getCalendarEvent: vi.fn().mockResolvedValue(null),
    ...overrides.calendar,
  };
  const repo = {
    claimSchedulingOperation: vi.fn().mockResolvedValue(overrides.claim ?? { outcome: 'created', op: { id: 'op-1', transaction_id: 'idem-1', interaction_id: null } }),
    markOperation: vi.fn().mockResolvedValue(undefined),
    createScheduledMeeting: vi.fn().mockResolvedValue({ id: 'int-1', tenant_id: TENANT, status: 'scheduled', version: 0, provider_event_id: 'evt-1', join_reference: 'j', initiated_by_id: RECRUITER, started_at: new Date(), ended_at: new Date() }),
    findScheduledMeeting: vi.fn().mockResolvedValue(overrides.findScheduledMeeting ?? null),
    reserveMutationCas: vi.fn().mockResolvedValue(overrides.reserve ?? { conflict: false, reserved_version: 3 }),
    finalizeReschedule: vi.fn().mockResolvedValue((overrides as { finalize?: unknown }).finalize ?? { ok: true }),
    finalizeCancel: vi.fn().mockResolvedValue((overrides as { finalize?: unknown }).finalize ?? { ok: true }),
    reconcileLockedMutation: vi.fn().mockResolvedValue({ ok: true }),
    listUpcomingMeetings: vi.fn().mockResolvedValue([]),
    writeAudit: vi.fn().mockResolvedValue(undefined),
  };
  const validator = {
    assertTenantOwnership: vi.fn().mockResolvedValue(undefined),
    assertRecruitingAssociation: vi.fn().mockResolvedValue(undefined),
    ...overrides.validator,
  };
  const consent = { assertInvitationAllowed: vi.fn().mockResolvedValue(undefined), ...overrides.consent };
  const delegated = { getUsableAccessToken: vi.fn().mockResolvedValue({ access_token: 'tok' }) };
  const graph = { getMe: vi.fn().mockResolvedValue({ user_principal_name: 'r@x.com' }) };
  const config = { resolveConnectionId: vi.fn().mockResolvedValue('conn-1'), resolveConfig: vi.fn().mockResolvedValue({ clientId: 'c', clientSecret: 's' }), nowSeconds: () => 1_000_000 };
  const talents = { findContactByIds: vi.fn().mockResolvedValue(new Map([[TALENT, { email: 'tal@x.com' }]])) };
  const svc = new MicrosoftSchedulingService(delegated as never, calendar as never, graph as never, repo as never, config as never, validator as never, consent as never, talents as never);
  return { svc, calendar, repo, validator, consent };
}

const scheduleArgs: ScheduleMeetingArgs = {
  tenant_id: TENANT, recruiter_id: RECRUITER, talent_record_id: TALENT, requisition_id: REQ,
  subject: 'Screen', start_date_time: '2026-11-01T10:00:00', end_date_time: '2026-11-01T10:30:00',
  time_zone: 'America/New_York', idempotency_key: 'idem-1', authContext: {} as never, requestId: 'rq-1',
};

afterEach(() => vi.restoreAllMocks());

describe('scheduleMeeting — claim/validate/consent/intent/create (A1 R1/R3/C-4, FIX_NOW-2)', () => {
  it('claims the op, validates, enforces consent, then creates with the stable transactionId', async () => {
    const { svc, calendar, repo, validator, consent } = build({});
    const view = await svc.scheduleMeeting(scheduleArgs);
    expect(repo.claimSchedulingOperation).toHaveBeenCalledOnce();
    expect(validator.assertRecruitingAssociation).toHaveBeenCalledOnce();
    expect(consent.assertInvitationAllowed).toHaveBeenCalledOnce();
    const createArg = calendar.createCalendarEvent.mock.calls[0][0] as { transactionId: string; isOnlineMeeting: boolean; attendees: unknown[] };
    expect(createArg.transactionId).toBe('idem-1');
    expect(createArg.isOnlineMeeting).toBe(true);
    expect(createArg.attendees).toEqual([{ email: 'tal@x.com', type: 'required' }]);
    expect(repo.markOperation).toHaveBeenCalledWith('op-1', expect.objectContaining({ status: 'succeeded' }));
    expect(view.status).toBe('scheduled');
  });

  it('an ambiguous Graph outcome marks the op unresolved and creates NO meeting (R3)', async () => {
    const ambiguous = new GraphCalendarError('transient', 503, 'timeout', undefined, true);
    const { svc, repo } = build({ calendar: { createCalendarEvent: vi.fn().mockRejectedValue(ambiguous) } });
    await expect(svc.scheduleMeeting(scheduleArgs)).rejects.toBeInstanceOf(MeetingScheduleUnresolvedError);
    expect(repo.markOperation).toHaveBeenCalledWith('op-1', expect.objectContaining({ status: 'unresolved' }));
    expect(repo.createScheduledMeeting).not.toHaveBeenCalled();
  });

  it('an invalid association marks the op failed (reclaimable) and never contacts/creates', async () => {
    const { svc, consent, calendar, repo } = build({ validator: { assertRecruitingAssociation: vi.fn().mockRejectedValue(new Error('assoc')) } });
    await expect(svc.scheduleMeeting(scheduleArgs)).rejects.toThrow();
    expect(consent.assertInvitationAllowed).not.toHaveBeenCalled();
    expect(calendar.createCalendarEvent).not.toHaveBeenCalled();
    expect(repo.markOperation).toHaveBeenCalledWith('op-1', expect.objectContaining({ status: 'failed' }));
  });

  it('missing/stale consent marks the op failed and never creates', async () => {
    const { svc, calendar, repo } = build({ consent: { assertInvitationAllowed: vi.fn().mockRejectedValue(new Error('consent')) } });
    await expect(svc.scheduleMeeting(scheduleArgs)).rejects.toThrow();
    expect(calendar.createCalendarEvent).not.toHaveBeenCalled();
    expect(repo.markOperation).toHaveBeenCalledWith('op-1', expect.objectContaining({ status: 'failed' }));
  });

  it('a succeeded operation replays its existing meeting without re-contacting (ownership enforced in claim)', async () => {
    const { svc, calendar, validator, consent } = build({
      claim: { outcome: 'replay', op: { id: 'op-1', transaction_id: 'idem-1', interaction_id: 'int-1' } },
      findScheduledMeeting: { ...activeMeeting },
    });
    const view = await svc.scheduleMeeting(scheduleArgs);
    expect(view.idempotent_replay).toBe(true);
    expect(validator.assertRecruitingAssociation).not.toHaveBeenCalled();
    expect(consent.assertInvitationAllowed).not.toHaveBeenCalled();
    expect(calendar.createCalendarEvent).not.toHaveBeenCalled();
  });

  it('a key reused with different identity/input is refused — no create (FIX_NOW-2)', async () => {
    const { svc, calendar } = build({ claim: { outcome: 'identity_conflict', op: { id: 'op-x', transaction_id: 'idem-1' } } });
    await expect(svc.scheduleMeeting(scheduleArgs)).rejects.toBeInstanceOf(MeetingIdempotencyConflictError);
    expect(calendar.createCalendarEvent).not.toHaveBeenCalled();
  });

  it('a concurrent in-flight attempt is refused — no independent create (FIX_NOW-2)', async () => {
    const { svc, calendar } = build({ claim: { outcome: 'in_progress', op: { id: 'op-1', transaction_id: 'idem-1' } } });
    await expect(svc.scheduleMeeting(scheduleArgs)).rejects.toBeInstanceOf(MeetingOperationInProgressError);
    expect(calendar.createCalendarEvent).not.toHaveBeenCalled();
  });

  it('an uncertain prior op (needs_reconciliation) surfaces and NEVER auto-recreates (PR#918 FIX-4)', async () => {
    const { svc, calendar } = build({ claim: { outcome: 'needs_reconciliation', op: { id: 'op-1', transaction_id: 'idem-1' } } });
    await expect(svc.scheduleMeeting(scheduleArgs)).rejects.toBeInstanceOf(MeetingScheduleUnresolvedError);
    expect(calendar.createCalendarEvent).not.toHaveBeenCalled();
  });
});

describe('reschedule/cancel — RESERVE before Graph (A1 R2/R3, FIX_NOW-1)', () => {
  const reArgs: RescheduleMeetingArgs = {
    tenant_id: TENANT, recruiter_id: RECRUITER, interaction_id: 'int-1', expected_version: 2,
    start_date_time: '2026-11-02T10:00:00', end_date_time: '2026-11-02T10:30:00', time_zone: 'UTC', requestId: 'rq',
  };
  const cancelArgs: CancelMeetingArgs = {
    tenant_id: TENANT, recruiter_id: RECRUITER, interaction_id: 'int-1', expected_version: 2, requestId: 'rq',
  };

  it('reschedule reserves, then updates the SAME provider event, then finalizes + audits', async () => {
    const { svc, calendar, repo } = build({ findScheduledMeeting: activeMeeting });
    await svc.rescheduleMeeting(reArgs);
    expect(repo.reserveMutationCas).toHaveBeenCalledWith(expect.objectContaining({ expected_version: 2 }));
    expect(calendar.updateCalendarEvent.mock.calls[0][0]).toMatchObject({ providerEventId: 'evt-1' });
    expect(repo.finalizeReschedule).toHaveBeenCalledWith(expect.objectContaining({ reserved_version: 3 }));
    expect(repo.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'meeting.rescheduled' }));
  });

  it('a stale-version reschedule conflicts at the reservation and issues ZERO Graph update calls (FIX_NOW-1)', async () => {
    const { svc, calendar } = build({ findScheduledMeeting: activeMeeting, reserve: { conflict: true, reserved_version: 3 } });
    await expect(svc.rescheduleMeeting(reArgs)).rejects.toBeInstanceOf(MeetingVersionConflictError);
    expect(calendar.updateCalendarEvent).not.toHaveBeenCalled();
  });

  it('a non-organizer cannot reschedule — refused before the reservation and before Graph (R2)', async () => {
    const { svc, calendar, repo } = build({ findScheduledMeeting: { ...activeMeeting, initiated_by_id: 'other' } });
    await expect(svc.rescheduleMeeting(reArgs)).rejects.toBeInstanceOf(MeetingOrganizerMismatchError);
    expect(repo.reserveMutationCas).not.toHaveBeenCalled();
    expect(calendar.updateCalendarEvent).not.toHaveBeenCalled();
  });

  it('a stale-version cancel conflicts at the reservation and issues ZERO Graph cancel calls (FIX_NOW-1)', async () => {
    const { svc, calendar } = build({ findScheduledMeeting: activeMeeting, reserve: { conflict: true, reserved_version: 3 } });
    await expect(svc.cancelMeeting(cancelArgs)).rejects.toBeInstanceOf(MeetingVersionConflictError);
    expect(calendar.cancelCalendarEvent).not.toHaveBeenCalled();
  });

  it('cancel of an already-cancelled meeting is idempotent — no reservation, no provider call', async () => {
    const { svc, calendar, repo } = build({ findScheduledMeeting: { ...activeMeeting, status: 'cancelled' } });
    const view = await svc.cancelMeeting(cancelArgs);
    expect(view.idempotent_replay).toBe(true);
    expect(repo.reserveMutationCas).not.toHaveBeenCalled();
    expect(calendar.cancelCalendarEvent).not.toHaveBeenCalled();
  });

  it('a finalize that lands ZERO rows never emits a success audit — surfaces unresolved (PR#918 FIX-2)', async () => {
    const { svc, repo } = build({ findScheduledMeeting: activeMeeting, finalize: { ok: false } });
    await expect(svc.rescheduleMeeting(reArgs)).rejects.toBeInstanceOf(MeetingScheduleUnresolvedError);
    const auditTypes = repo.writeAudit.mock.calls.map((c) => (c[0] as { event_type: string }).event_type);
    expect(auditTypes).not.toContain('meeting.rescheduled');
    expect(auditTypes).toContain('meeting.provider_failed');
  });
});

describe('reconcileMeeting — provider-verified release (A1 R3/R6, PR#918 reconciliation pass)', () => {
  const fencedReschedule = {
    id: 'int-1', tenant_id: TENANT, status: 'scheduled', version: 3, provider_event_id: 'evt-1',
    join_reference: 'j', initiated_by_id: RECRUITER, started_at: new Date(), ended_at: new Date(),
    mutation_locked_at: new Date(), pending_mutation: 'reschedule',
    pending_start: new Date('2026-11-20T10:00:00.000Z'), pending_end: new Date('2026-11-20T10:30:00.000Z'),
  };
  const reconcileArgs = { tenant_id: TENANT, recruiter_id: RECRUITER, interaction_id: 'int-1' };
  const presentAtIntent = vi.fn().mockResolvedValue({
    provider_event_id: 'evt-1', start_date_time: '2026-11-20T10:00:00.000Z', end_date_time: '2026-11-20T10:30:00.000Z',
  });

  it('releases the fence to rescheduled ONLY when the provider window matches — reconcileLockedMutation(rescheduled) + reconciled audit', async () => {
    const { svc, repo } = build({ findScheduledMeeting: fencedReschedule, calendar: { getCalendarEvent: presentAtIntent } });
    await svc.reconcileMeeting(reconcileArgs);
    expect(repo.reconcileLockedMutation).toHaveBeenCalledWith(expect.objectContaining({ resolved_status: 'rescheduled' }));
    const auditTypes = repo.writeAudit.mock.calls.map((c) => (c[0] as { event_type: string }).event_type);
    expect(auditTypes).toContain('meeting.reconciled');
  });

  it('a reconcile whose finalize does NOT land stays unresolved — reconcileLockedMutation called but NO reconciled audit (PR#918 FIX-2 parity)', async () => {
    const { svc, repo } = build({ findScheduledMeeting: fencedReschedule, calendar: { getCalendarEvent: presentAtIntent } });
    repo.reconcileLockedMutation.mockResolvedValue({ ok: false });
    await expect(svc.reconcileMeeting(reconcileArgs)).rejects.toBeInstanceOf(MeetingScheduleUnresolvedError);
    expect(repo.reconcileLockedMutation).toHaveBeenCalledOnce();
    const auditTypes = repo.writeAudit.mock.calls.map((c) => (c[0] as { event_type: string }).event_type);
    expect(auditTypes).not.toContain('meeting.reconciled');
    expect(auditTypes).toContain('meeting.provider_failed');
  });

  it('an inconclusive provider lookup never releases the fence — no reconcile write, no reconciled audit', async () => {
    const throwing = vi.fn().mockRejectedValue(new GraphCalendarError('transient', 503, 'get timeout'));
    const { svc, repo } = build({ findScheduledMeeting: fencedReschedule, calendar: { getCalendarEvent: throwing } });
    await expect(svc.reconcileMeeting(reconcileArgs)).rejects.toBeInstanceOf(MeetingScheduleUnresolvedError);
    expect(repo.reconcileLockedMutation).not.toHaveBeenCalled();
    const auditTypes = repo.writeAudit.mock.calls.map((c) => (c[0] as { event_type: string }).event_type);
    expect(auditTypes).not.toContain('meeting.reconciled');
  });

  it('a non-organizer cannot reconcile another recruiter’s meeting (R2)', async () => {
    const { svc, repo } = build({ findScheduledMeeting: { ...fencedReschedule, initiated_by_id: 'other' } });
    await expect(svc.reconcileMeeting(reconcileArgs)).rejects.toBeInstanceOf(MeetingOrganizerMismatchError);
    expect(repo.reconcileLockedMutation).not.toHaveBeenCalled();
  });
});
