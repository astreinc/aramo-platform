import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';
import type { IdentityDependencyInspector, IdentityDependencyReport, PrivacyRequestRecord, PrivacyRequestService, PrivacySubjectService } from '@aramo/identity';
import type { SignPrivacyRepository } from '@aramo/sign';

import { PlatformPrivacyRequestsController } from '../app/platform/platform-privacy-requests.controller.js';

// PRIV-ADMIN-1 (LOCKED) §1.1 — the operator API behind the console: queue filters and
// the failing count, a detail without the contact email (OD-8), the audited reveal, the
// operator note, the read-only impact preview, return to queue (OD-4), the referral
// tenant check, and complete (OD-1 / OD-2).

const FLAG = 'SIGN_PRIVACY_DELETION_EXECUTION_ENABLED';
const OP = '01900000-0000-7000-8000-00000000e0aa';
const auth = (consumer_type = 'platform') => ({ sub: OP, consumer_type }) as unknown as AuthContextType;
const NOW = new Date('2026-11-27T10:00:00.000Z');

function record(over: Partial<PrivacyRequestRecord> = {}): PrivacyRequestRecord {
  return {
    id: 'r1',
    reference: 'PR-0000-0000-0000',
    product: 'SIGN',
    request_type: 'DELETION',
    subject_kind: 'ACCOUNT_HOLDER',
    channel: 'WEB',
    status: 'DATA_INVENTORY',
    subject_user_id: 'u1',
    subject_tenant_id: 't1',
    referred_tenant_id: null,
    contact_email_hash: 'h',
    contact_email_ciphertext: 'c',
    due_at: new Date(NOW.getTime() + 1000),
    assigned_operator_id: null,
    inventory: null,
    completion_evidence: null,
    outcome_code: null,
    outcome_text: null,
    identity_validated_at: NOW,
    completed_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

const ctx = (over: Record<string, unknown> = {}) => ({
  user_id: 'u1',
  tenant_id: 't1',
  email: 'pat@example.test',
  user_active: true,
  tenant_kind: 'PERSONAL',
  tenant_status: 'ACTIVE',
  legal_hold: false,
  membership_id: 'm1',
  membership_active: true,
  role_keys: ['tenant_owner'],
  is_owner: true,
  ...over,
});

function report(over: Partial<IdentityDependencyReport> = {}): IdentityDependencyReport {
  return {
    dependencies: [],
    legal_hold: false,
    retire_identity: true,
    may_close_tenant: true,
    a_other_products: [],
    b_other_memberships: 0,
    c_shared_identity_users: 0,
    d_platform_roles: [],
    e_cognito: { status: 'clear', pool: 'ok', subject_found: true, linked_providers: 0, other_users_same_email: 0 },
    f_legal_hold: { tenant: false, document_artifacts: 0 },
    g_preserved: { agreements_awaiting_user: 0, agreements_sent_open: 0, completed_agreements: 0, signed_signer_records: 0 },
    cognito_sub: 's1',
    ...over,
  };
}

function setup(opts: { rec?: PrivacyRequestRecord; rows?: PrivacyRequestRecord[]; ctx?: unknown; report?: IdentityDependencyReport | Error; attempts?: Record<string, number> } = {}) {
  const rec = opts.rec ?? record();
  const requests = {
    findById: vi.fn(async () => rec),
    listQueue: vi.fn(async () => opts.rows ?? [rec]),
    transition: vi.fn(async (_id: string, to: string) => ({ ...rec, status: to })),
    recordEvent: vi.fn(async () => undefined),
    events: vi.fn(async () => [{ id: 'e1', event_type: 'CREATED' }]),
    contactEmail: vi.fn(() => 'pat@example.test'),
    executionAttempts: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, { attempts: opts.attempts?.[id] ?? 0, last_failure_at: null, last_error: null }]))),
    view: vi.fn((r: PrivacyRequestRecord) => ({ reference: r.reference, status: r.status, request_type: r.request_type })),
  };
  const subjects = { context: vi.fn(async () => (opts.ctx === undefined ? ctx() : opts.ctx)) };
  const inspector = {
    inspect: vi.fn(async () => {
      if (opts.report instanceof Error) throw opts.report;
      return opts.report ?? report();
    }),
  };
  const ctl = new PlatformPrivacyRequestsController(
    requests as unknown as PrivacyRequestService,
    subjects as unknown as PrivacySubjectService,
    {} as SignPrivacyRepository,
    inspector as unknown as IdentityDependencyInspector,
  );
  return { ctl, requests, subjects, inspector };
}

const list = (ctl: PlatformPrivacyRequestsController, q: Partial<Record<'status' | 'request_type' | 'include_closed' | 'limit' | 'channel' | 'subject_kind' | 'assigned' | 'overdue' | 'reference', string>> = {}, a = auth()) =>
  ctl.list(a, 'rq', q.status, q.request_type, q.include_closed, q.limit, q.channel, q.subject_kind, q.assigned, q.overdue, q.reference);

describe('PRIV-ADMIN-1 — operator API', () => {
  afterEach(() => {
    delete process.env[FLAG];
  });

  describe('GET / (queue)', () => {
    it('defaults to 200 rows and passes every filter; assigned=me is the caller', async () => {
      const { ctl, requests } = setup();
      await list(ctl);
      expect(requests.listQueue).toHaveBeenLastCalledWith({ include_closed: false, limit: 200 });
      await list(ctl, { limit: '500', channel: 'WEB', subject_kind: 'BUSINESS_MEMBER', assigned: 'me', overdue: 'true' });
      expect(requests.listQueue).toHaveBeenLastCalledWith({ channel: 'WEB', subject_kind: 'BUSINESS_MEMBER', assigned_operator_id: OP, overdue: true, include_closed: false, limit: 500 });
    });

    it('a reference is normalized and searched whatever the status; one that cannot exist matches nothing', async () => {
      const { ctl, requests } = setup();
      await list(ctl, { reference: ' pr-7k3m-9qx2-h4td ' });
      expect(requests.listQueue).toHaveBeenLastCalledWith({ reference: 'PR-7K3M-9QX2-H4TD', include_closed: true, limit: 200 });
      requests.listQueue.mockClear();
      expect((await list(ctl, { reference: 'PR-bad' })).items).toEqual([]);
      expect(requests.listQueue).not.toHaveBeenCalled();
    });

    it('refuses bad filter values with 400', async () => {
      const { ctl } = setup();
      for (const [q, reason] of [
        [{ limit: '0' }, 'invalid_limit'],
        [{ limit: '501' }, 'invalid_limit'],
        [{ limit: 'ten' }, 'invalid_limit'],
        [{ channel: 'EMAIL' }, 'invalid_channel'],
        [{ subject_kind: 'ROBOT' }, 'invalid_subject_kind'],
        [{ assigned: 'someone' }, 'invalid_assigned'],
        [{ overdue: 'yes' }, 'invalid_overdue'],
      ] as const) {
        await expect(list(ctl, q)).rejects.toMatchObject({ statusCode: 400, context: { details: { reason } } });
      }
    });

    it('each item carries `failing` (attempts since entering EXECUTING; 0 otherwise)', async () => {
      const rows = [record({ id: 'x', status: 'EXECUTING' }), record({ id: 'y', status: 'DATA_INVENTORY' })];
      const { ctl, requests } = setup({ rows, attempts: { x: 2, y: 3 } });
      const out = await list(ctl);
      expect(requests.executionAttempts).toHaveBeenCalledWith(['x']);
      expect(out.items.map((i) => [i.id, i.failing])).toEqual([
        ['x', 2],
        ['y', 0],
      ]);
    });
  });

  describe('GET /:id', () => {
    it('never returns the contact email; returns contact_present, attempts and the events', async () => {
      const { ctl, requests } = setup({ rec: record({ status: 'EXECUTING' }), attempts: { r1: 3 } });
      const out = await ctl.detail('r1', auth(), 'rq');
      expect(out).not.toHaveProperty('contact_email');
      expect(JSON.stringify(out)).not.toContain('pat@example.test');
      expect(out).toMatchObject({ contact_present: true, attempts: 3, events: [{ event_type: 'CREATED' }] });
      expect(requests.contactEmail).not.toHaveBeenCalled();
      const none = setup({ rec: record({ contact_email_ciphertext: null, contact_email_hash: null }) });
      expect(await none.ctl.detail('r1', auth(), 'rq')).toMatchObject({ contact_present: false, attempts: 0 });
    });
  });

  it('POST /:id/reveal-contact returns the email and writes CONTACT_REVEALED with the operator', async () => {
    const { ctl, requests } = setup();
    expect(await ctl.revealContact('r1', auth(), 'rq')).toEqual({ contact_email: 'pat@example.test' });
    expect(requests.recordEvent).toHaveBeenCalledWith('r1', 'CONTACT_REVEALED', { actor_type: 'OPERATOR', actor_id: OP }, { revealed: true });
    await expect(ctl.revealContact('r1', auth('sign'), 'rq')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('POST /:id/note writes NOTE (never the requester-visible outcome) and no transition', async () => {
    const { ctl, requests } = setup();
    await ctl.note('r1', { note: 'called the requester' }, auth(), 'rq');
    expect(requests.recordEvent).toHaveBeenCalledWith('r1', 'NOTE', { actor_type: 'OPERATOR', actor_id: OP }, { note: 'called the requester' });
    expect(requests.transition).not.toHaveBeenCalled();
  });

  describe('GET /:id/preview (read-only)', () => {
    const noWrites = (requests: ReturnType<typeof setup>['requests']) => {
      expect(requests.transition).not.toHaveBeenCalled();
      expect(requests.recordEvent).not.toHaveBeenCalled();
    };

    it('Personal owner with no dependency → personal_full; with dependencies → personal_retain', async () => {
      const full = setup();
      expect(await full.ctl.preview('r1', auth(), 'rq')).toEqual({ path: 'personal_full', reasons: [], dependencies: [], unknown_sources: [], execution_enabled: false });
      expect(full.inspector.inspect).toHaveBeenCalledWith('u1', 't1', { scope: 'sign' });
      noWrites(full.requests);
      const retain = setup({ report: report({ dependencies: ['A_OTHER_PRODUCT', 'D_PLATFORM_ROLE'], retire_identity: false }) });
      expect(await retain.ctl.preview('r1', auth(), 'rq')).toMatchObject({ path: 'personal_retain', dependencies: ['A_OTHER_PRODUCT', 'D_PLATFORM_ROLE'] });
      noWrites(retain.requests);
    });

    it('an unreadable Cognito pool is `unknown` (never a failure); an inspector error is `unknown` too', async () => {
      const cognito = setup({
        report: report({ dependencies: ['E_COGNITO_POOL'], retire_identity: false, e_cognito: { status: 'unverified', pool: 'not_configured', subject_found: false, linked_providers: 0, other_users_same_email: 0 } }),
      });
      expect(await cognito.ctl.preview('r1', auth(), 'rq')).toEqual({ path: 'personal_full', reasons: [], dependencies: ['unknown'], unknown_sources: ['E_COGNITO_POOL'], execution_enabled: false });
      const broken = setup({ report: new Error('boom') });
      expect(await broken.ctl.preview('r1', auth(), 'rq')).toMatchObject({ path: 'personal_full', dependencies: ['unknown'], unknown_sources: ['inspector'] });
      noWrites(broken.requests);
    });

    it('a Business member → member (no inspection); not executable: no account subject, subject mismatch, legal hold, not a deletion', async () => {
      process.env[FLAG] = '1';
      const member = setup({ ctx: ctx({ tenant_kind: 'BUSINESS', role_keys: ['sign_sender'], is_owner: false }) });
      expect(await member.ctl.preview('r1', auth(), 'rq')).toEqual({ path: 'member', reasons: [], dependencies: [], unknown_sources: [], execution_enabled: true });
      expect(member.inspector.inspect).not.toHaveBeenCalled();
      expect(await setup({ rec: record({ subject_user_id: null, subject_tenant_id: null }) }).ctl.preview('r1', auth(), 'rq')).toMatchObject({ path: 'not_executable', reasons: ['no_account_subject'] });
      expect(await setup({ ctx: null }).ctl.preview('r1', auth(), 'rq')).toMatchObject({ path: 'not_executable', reasons: ['subject_mismatch'] });
      expect(await setup({ ctx: ctx({ legal_hold: true }) }).ctl.preview('r1', auth(), 'rq')).toMatchObject({ path: 'not_executable', reasons: ['legal_hold'] });
      expect(await setup({ report: report({ legal_hold: true, retire_identity: false }) }).ctl.preview('r1', auth(), 'rq')).toMatchObject({ path: 'not_executable', reasons: ['legal_hold'] });
      expect(await setup({ rec: record({ request_type: 'ACCESS' }) }).ctl.preview('r1', auth(), 'rq')).toMatchObject({ path: 'not_executable', reasons: ['not_a_deletion'] });
    });
  });

  it('POST /:id/return-to-queue: EXECUTING → DATA_INVENTORY by the operator, then RETURNED_TO_QUEUE', async () => {
    const { ctl, requests } = setup({ rec: record({ status: 'EXECUTING' }) });
    const out = await ctl.returnToQueue('r1', { note: 'storage outage' }, auth(), 'rq');
    expect(out.status).toBe('DATA_INVENTORY');
    expect(requests.transition).toHaveBeenCalledWith('r1', 'DATA_INVENTORY', { actor_type: 'OPERATOR', actor_id: OP }, expect.objectContaining({ from: ['EXECUTING'] }));
    expect(requests.recordEvent).toHaveBeenCalledWith('r1', 'RETURNED_TO_QUEUE', { actor_type: 'OPERATOR', actor_id: OP }, { note: 'storage outage' });
    // A refused transition (not EXECUTING) writes no RETURNED_TO_QUEUE event.
    const refused = setup();
    refused.requests.transition.mockRejectedValueOnce(Object.assign(new Error('x'), { statusCode: 409 }));
    await expect(refused.ctl.returnToQueue('r1', { note: 'n' }, auth(), 'rq')).rejects.toMatchObject({ statusCode: 409 });
    expect(refused.requests.recordEvent).not.toHaveBeenCalled();
  });

  it('refer: only the subject’s own organization (omitted = it); anything else 409 privacy_referral_tenant_mismatch', async () => {
    const { ctl, requests } = setup();
    await ctl.refer('r1', { note: 'n' }, auth(), 'rq');
    expect(requests.transition).toHaveBeenLastCalledWith('r1', 'REFERRED_TO_ORGANIZATION', expect.anything(), expect.objectContaining({ patch: { referred_tenant_id: 't1' } }));
    await ctl.refer('r1', { note: 'n', organization_tenant_id: 't1' }, auth(), 'rq');
    requests.transition.mockClear();
    await expect(ctl.refer('r1', { note: 'n', organization_tenant_id: 'another-tenant' }, auth(), 'rq')).rejects.toMatchObject({
      statusCode: 409,
      context: { details: { reason: 'privacy_referral_tenant_mismatch' } },
    });
    const noSubject = setup({ rec: record({ subject_user_id: null, subject_tenant_id: null }) });
    await expect(noSubject.ctl.refer('r1', { note: 'n', organization_tenant_id: 't9' }, auth(), 'rq')).rejects.toMatchObject({ context: { details: { reason: 'privacy_referral_tenant_mismatch' } } });
    expect(requests.transition).not.toHaveBeenCalled();
  });

  it('complete: refuses a DELETION in every status (OD-1); completes ACCESS / EXPORT / CORRECTION from DATA_INVENTORY or REFERRED (OD-2)', async () => {
    for (const status of ['DATA_INVENTORY', 'REFERRED_TO_ORGANIZATION', 'EXECUTING'] as const) {
      const d = setup({ rec: record({ status }) });
      await expect(d.ctl.complete('r1', { note: 'done' }, auth(), 'rq')).rejects.toMatchObject({ statusCode: 409, context: { details: { reason: 'privacy_deletion_completes_by_execution' } } });
      expect(d.requests.transition).not.toHaveBeenCalled();
    }
    for (const request_type of ['ACCESS', 'EXPORT', 'CORRECTION'] as const) {
      const a = setup({ rec: record({ request_type }) });
      expect((await a.ctl.complete('r1', { note: 'sent the copy' }, auth(), 'rq')).status).toBe('COMPLETED');
      expect(a.requests.transition).toHaveBeenCalledWith(
        'r1',
        'COMPLETED',
        { actor_type: 'OPERATOR', actor_id: OP },
        expect.objectContaining({ from: ['DATA_INVENTORY', 'REFERRED_TO_ORGANIZATION'], patch: { outcome_code: 'operator_completed', outcome_text: 'sent the copy' } }),
      );
    }
  });
});
