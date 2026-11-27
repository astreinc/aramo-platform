import { randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrivacyRequestRecord } from '@aramo/identity';

import { SignPrivacyExecutionService } from '../app/privacy/sign-privacy-execution.service.js';
import { SignPrivacyExecutionWorker } from '../app/privacy/sign-privacy-execution.worker.js';
import { PrivacyWebBudget, SignPrivacyRequestService } from '../app/privacy/sign-privacy-request.service.js';

// PRIV-ADMIN-1 (LOCKED) §1.2 — the Sign service side:
//   OD-3  the Business-member path keeps the member's Sign roles (access removal is the
//         organization's route) and still revokes sessions + own convenience data;
//   OD-4  worker back-off (1, 5, 15, 60 min), the cap (5th failure → DATA_INVENTORY with
//         EXECUTION_GAVE_UP), no starvation by failing requests;
//   OD-11 a web Business-member DELETION is referred to the subject's organization;
//   OD-13 stored_objects_deleted counts only objects actually deleted; unreadable session
//         counts stay null.
// Every test pins NOW and injects the same NOW into the code under test.

const FLAG = 'SIGN_PRIVACY_DELETION_EXECUTION_ENABLED';
const NOW = new Date('2026-11-27T10:00:00.000Z');
const min = (m: number) => new Date(NOW.getTime() + m * 60_000);

function rec(over: Partial<PrivacyRequestRecord> = {}): PrivacyRequestRecord {
  return {
    id: 'r1',
    reference: 'PR-0000-0000-0001',
    product: 'SIGN',
    request_type: 'DELETION',
    subject_kind: 'BUSINESS_MEMBER',
    channel: 'IN_APP',
    status: 'EXECUTING',
    subject_user_id: 'u1',
    subject_tenant_id: 't1',
    referred_tenant_id: 't1',
    contact_email_hash: null,
    contact_email_ciphertext: null,
    due_at: min(60 * 24 * 30),
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

const memberCtx = { user_id: 'u1', tenant_id: 't1', email: 'pat@example.test', user_active: true, tenant_kind: 'BUSINESS', tenant_status: 'ACTIVE', legal_hold: false, membership_id: 'm1', membership_active: true, role_keys: ['sign_sender'], is_owner: false };
const personalCtx = { ...memberCtx, tenant_kind: 'PERSONAL', role_keys: ['tenant_owner'], is_owner: true };

function execution(opts: { req?: PrivacyRequestRecord; ctx?: unknown; sessions?: { device_sessions_revoked: number | null; refresh_tokens_revoked: number | null }; attempts?: number; failWith?: Error; storage?: unknown } = {}) {
  const req = opts.req ?? rec();
  const requests = {
    findById: vi.fn(async () => req),
    transition: vi.fn(async (_id: string, to: string) => ({ ...req, status: to })),
    recordEvent: vi.fn(async () => undefined),
    executionAttempts: vi.fn(async () => new Map([[req.id, { attempts: opts.attempts ?? 1, last_failure_at: NOW, last_error: 'E' }]])),
  };
  const subjects = { context: vi.fn(async () => opts.ctx ?? memberCtx), removeSignAccess: vi.fn() };
  const sign = {
    revokeSignSessions: vi.fn(async () => {
      if (opts.failWith !== undefined) throw opts.failWith;
      return opts.sessions ?? { device_sessions_revoked: 1, refresh_tokens_revoked: 2 };
    }),
    removeRecipientBindings: vi.fn(async () => 0),
    draftEnvelopeIds: vi.fn(async () => ['env-1']),
  };
  const drafts = { deleteDraft: vi.fn(async () => ({ document_count: 1, source_object_keys: ['k1', 'k2'] })) };
  const notifications = { purgeOwner: vi.fn(async () => ({ push_devices_deleted: 0 })) };
  const signatures = { removeAllForUser: vi.fn(async () => 2) };
  const contacts = { removeAllForUser: vi.fn(async () => 1) };
  const inspector = {
    inspect: vi.fn(async () => ({
      legal_hold: false,
      retire_identity: false,
      dependencies: ['A_OTHER_PRODUCT'],
      may_close_tenant: false,
      a_other_products: ['ats'],
      b_other_memberships: 0,
      c_shared_identity_users: 0,
      d_platform_roles: [],
      e_cognito: { status: 'clear', pool: 'ok', subject_found: true, linked_providers: 0, other_users_same_email: 0 },
      f_legal_hold: { tenant: false, document_artifacts: 0 },
      g_preserved: { agreements_awaiting_user: 0, agreements_sent_open: 0, completed_agreements: 0, signed_signer_records: 0 },
      cognito_sub: 's1',
    })),
  };
  const risk = { riskStateOf: vi.fn(async () => ({ state: 'closed' })), close: vi.fn() };
  const svc = new SignPrivacyExecutionService(
    requests as never,
    subjects as never,
    {} as never,
    risk as never,
    sign as never,
    drafts as never,
    notifications as never,
    signatures as never,
    contacts as never,
    inspector as never,
    {} as never,
    opts.storage as never,
  );
  return { svc, requests, subjects, sign, drafts };
}

describe('PRIV-ADMIN-1 — Sign privacy execution', () => {
  beforeEach(() => {
    process.env[FLAG] = '1';
  });
  afterEach(() => {
    delete process.env[FLAG];
  });

  it('OD-3 — the Business-member path keeps the Sign roles; sessions + own convenience data only', async () => {
    const { svc, requests, subjects, sign, drafts } = execution();
    const out = await svc.execute('r1', NOW);
    expect(out.status).toBe('completed');
    expect(subjects.removeSignAccess).not.toHaveBeenCalled();
    expect(sign.revokeSignSessions).toHaveBeenCalledWith({ tenant_id: 't1', user_id: 'u1', reason: 'privacy_deletion' });
    expect(drafts.deleteDraft).not.toHaveBeenCalled();
    const [, to, , opts] = requests.transition.mock.calls[0] as unknown as [string, string, unknown, { patch: { completion_evidence: Record<string, unknown>; outcome_code: string; outcome_text: string } }];
    expect(to).toBe('COMPLETED');
    expect(opts.patch.outcome_code).toBe('member_sign_data_removed');
    expect(opts.patch.completion_evidence).toMatchObject({ path: 'business_member', sign_access: 'organization_administered', tenant_closed: false });
    expect(opts.patch.completion_evidence).not.toHaveProperty('sign_roles_removed');
    expect(opts.patch.outcome_text).not.toContain('access removed');
  });

  it('OD-13 (C-4) — session counts that could not be read stay null in the evidence, never 0', async () => {
    const { svc, requests } = execution({ sessions: { device_sessions_revoked: null, refresh_tokens_revoked: null } });
    await svc.execute('r1', NOW);
    const ev = (requests.transition.mock.calls[0] as unknown as [string, string, unknown, { patch: { completion_evidence: Record<string, unknown> } }])[3].patch.completion_evidence;
    expect(ev['device_sessions_revoked']).toBeNull();
    expect(ev['refresh_tokens_revoked']).toBeNull();
  });

  it('OD-13 (C-3) — without a storage port nothing is counted as deleted; with one, each deleted object counts', async () => {
    const noPort = execution({ ctx: personalCtx });
    await noPort.svc.execute('r1', NOW);
    const ev1 = (noPort.requests.transition.mock.calls[0] as unknown as [string, string, unknown, { patch: { completion_evidence: Record<string, unknown> } }])[3].patch.completion_evidence;
    expect(ev1).toMatchObject({ stored_objects_deleted: 0, stored_objects_not_deleted: 2, drafts_deleted: 1 });

    const portWithoutDelete = execution({ ctx: personalCtx, storage: {} });
    await portWithoutDelete.svc.execute('r1', NOW);
    const ev2 = (portWithoutDelete.requests.transition.mock.calls[0] as unknown as [string, string, unknown, { patch: { completion_evidence: Record<string, unknown> } }])[3].patch.completion_evidence;
    expect(ev2).toMatchObject({ stored_objects_deleted: 0, stored_objects_not_deleted: 2 });

    const deleteOwnedSource = vi.fn(async (_key: string) => undefined);
    const port = execution({ ctx: personalCtx, storage: { deleteOwnedSource } });
    await port.svc.execute('r1', NOW);
    const ev3 = (port.requests.transition.mock.calls[0] as unknown as [string, string, unknown, { patch: { completion_evidence: Record<string, unknown> } }])[3].patch.completion_evidence;
    expect(deleteOwnedSource.mock.calls.map((c) => c[0])).toEqual(['k1', 'k2']);
    expect(ev3).toMatchObject({ stored_objects_deleted: 2, stored_objects_not_deleted: 0 });
  });

  it('OD-4 — a failure is recorded with updated_at stamped (back of the queue) and stays EXECUTING below the cap', async () => {
    const boom = Object.assign(new Error('x'), { name: 'StorageOutage' });
    const { svc, requests } = execution({ failWith: boom, attempts: 4 });
    await expect(svc.execute('r1', NOW)).rejects.toBe(boom);
    expect(requests.recordEvent).toHaveBeenCalledWith('r1', 'EXECUTION_FAILED', { actor_type: 'SYSTEM', actor_id: null }, { error: 'StorageOutage' }, NOW, { touch: true });
    expect(requests.recordEvent).not.toHaveBeenCalledWith('r1', 'EXECUTION_GAVE_UP', expect.anything(), expect.anything(), expect.anything());
    expect(requests.transition).not.toHaveBeenCalled();
  });

  it('OD-4 — the 5th failure returns the request to DATA_INVENTORY with EXECUTION_GAVE_UP (attempts, last error name)', async () => {
    const boom = Object.assign(new Error('x'), { name: 'StorageOutage' });
    const { svc, requests } = execution({ failWith: boom, attempts: 5 });
    await expect(svc.execute('r1', NOW)).rejects.toBe(boom);
    expect(requests.recordEvent).toHaveBeenCalledWith('r1', 'EXECUTION_GAVE_UP', { actor_type: 'SYSTEM', actor_id: null }, { attempts: 5, last_error: 'StorageOutage' }, NOW);
    expect(requests.transition).toHaveBeenCalledWith('r1', 'DATA_INVENTORY', { actor_type: 'SYSTEM', actor_id: null }, { now: NOW, from: ['EXECUTING'], payload: { returned_because: 'EXECUTION_GAVE_UP' } });
  });
});

describe('PRIV-ADMIN-1 — Sign privacy execution worker (OD-4)', () => {
  beforeEach(() => {
    process.env[FLAG] = '1';
  });
  afterEach(() => {
    delete process.env[FLAG];
  });

  function worker(rows: PrivacyRequestRecord[], attempts: Record<string, { attempts: number; last_failure_at: Date | null }>) {
    const requests = {
      listExecuting: vi.fn(async () => rows),
      executionAttempts: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, { attempts: attempts[id]?.attempts ?? 0, last_failure_at: attempts[id]?.last_failure_at ?? null, last_error: null }]))),
    };
    const execute = vi.fn(async () => ({ status: 'completed' }));
    const w = new SignPrivacyExecutionWorker(requests as never, { execute } as never);
    return { w, requests, execute };
  }

  it('waits 1, 5, 15, 60 minutes after failure 1..4 (time injected)', async () => {
    for (const [n, wait] of [
      [1, 1],
      [2, 5],
      [3, 15],
      [4, 60],
    ] as const) {
      const early = worker([rec()], { r1: { attempts: n, last_failure_at: NOW } });
      expect(await early.w.tick(new Date(min(wait).getTime() - 1))).toBe(0);
      expect(early.execute).not.toHaveBeenCalled();
      const due = worker([rec()], { r1: { attempts: n, last_failure_at: NOW } });
      expect(await due.w.tick(min(wait))).toBe(1);
      expect(due.execute).toHaveBeenCalledWith('r1', min(wait));
    }
  });

  it('no starvation: requests in back-off do not take the batch; a fresh request behind them runs', async () => {
    const failing = Array.from({ length: 12 }, (_, i) => rec({ id: `f${i}`, reference: `PR-0000-0000-00${10 + i}` }));
    const fresh = rec({ id: 'fresh' });
    const backoff = Object.fromEntries(failing.map((r) => [r.id, { attempts: 1, last_failure_at: NOW }]));
    const { w, requests, execute } = worker([...failing, fresh], backoff);
    expect(await w.tick(NOW)).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('fresh', NOW);
    expect(requests.listExecuting).toHaveBeenCalledWith('SIGN', 100);
  });

  it('at most 10 requests are attempted per run; non-deletions are skipped', async () => {
    const rows = [rec({ id: 'acc', request_type: 'ACCESS' }), ...Array.from({ length: 12 }, (_, i) => rec({ id: `d${i}` }))];
    const { w, requests, execute } = worker(rows, {});
    expect(await w.tick(NOW)).toBe(10);
    expect(execute).not.toHaveBeenCalledWith('acc', NOW);
    expect(requests.executionAttempts).toHaveBeenCalledWith(rows.slice(1).map((r) => r.id));
  });
});

describe('PRIV-ADMIN-1 — web Business deletion is auto-referred on verify (OD-11)', () => {
  const KEY = 'PRIVACY_REQUEST_EMAIL_KEY';
  const saved = process.env[KEY];
  beforeEach(() => {
    process.env[KEY] = randomBytes(32).toString('base64');
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  function service(ctx: unknown, request_type: 'DELETION' | 'ACCESS' = 'DELETION') {
    let cur = rec({ status: 'RECEIVED', channel: 'WEB', request_type, subject_user_id: null, subject_tenant_id: null, referred_tenant_id: null });
    const requests = {
      consumeEmailProof: vi.fn(async () => ({ kind: 'fresh', proof_id: 'p1', email: 'pat@example.test', contact: { hash: 'h', ciphertext: 'c' }, request_type, product: 'SIGN' })),
      create: vi.fn(async (i: { subject_kind: string }) => (cur = { ...cur, subject_kind: i.subject_kind as PrivacyRequestRecord['subject_kind'] })),
      linkProof: vi.fn(async () => undefined),
      transition: vi.fn(async (_id: string, to: string, _a: unknown, o: { patch?: Record<string, unknown> }) => (cur = { ...cur, ...(o.patch ?? {}), status: to } as PrivacyRequestRecord)),
      view: vi.fn((r: PrivacyRequestRecord) => ({ reference: r.reference, status: r.status, subject_kind: r.subject_kind, request_type: r.request_type, referred_to_organization: r.referred_tenant_id !== null })),
    };
    const subjects = { findAccountByEmail: vi.fn(async () => (ctx === null ? null : { user_id: 'u1', tenant_id: 't1' })), context: vi.fn(async () => ctx) };
    const sign = { inventory: vi.fn(async () => ({ saved_signatures: 0 })) };
    const svc = new SignPrivacyRequestService(requests as never, subjects as never, {} as never, sign as never, {} as never, new PrivacyWebBudget(), {} as never);
    return { svc, requests };
  }

  it('a Business member DELETION → REFERRED_TO_ORGANIZATION (the subject tenant), never EXECUTING', async () => {
    const { svc, requests } = service(memberCtx);
    const out = await svc.verifyWeb({ token: 't'.repeat(43) }, '1.2.3.4', 'rq', NOW);
    expect(out).toMatchObject({ status: 'REFERRED_TO_ORGANIZATION', subject_kind: 'BUSINESS_MEMBER', referred_to_organization: true });
    expect(requests.transition.mock.calls.map((c) => c[1])).toEqual(['IDENTITY_VALIDATED', 'DATA_INVENTORY', 'REFERRED_TO_ORGANIZATION']);
    expect(requests.transition).toHaveBeenLastCalledWith('r1', 'REFERRED_TO_ORGANIZATION', { actor_type: 'SYSTEM', actor_id: null }, {
      now: NOW,
      patch: { referred_tenant_id: 't1' },
      payload: { referral: 'organization_documents', aramo_fallback: true },
    });
  });

  it('a Personal owner, a guest signer, or a Business ACCESS request stays in DATA_INVENTORY', async () => {
    for (const [ctx, type] of [
      [personalCtx, 'DELETION'],
      [null, 'DELETION'],
      [memberCtx, 'ACCESS'],
    ] as const) {
      const { svc, requests } = service(ctx, type);
      expect((await svc.verifyWeb({ token: 't'.repeat(43) }, '1.2.3.4', 'rq', NOW)).status).toBe('DATA_INVENTORY');
      expect(requests.transition.mock.calls.map((c) => c[1])).not.toContain('REFERRED_TO_ORGANIZATION');
    }
  });
});
