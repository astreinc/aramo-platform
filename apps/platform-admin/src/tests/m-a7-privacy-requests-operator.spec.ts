import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';
import type { PrivacyRequestRecord, PrivacyRequestService, PrivacySubjectService } from '@aramo/identity';
import type { SignPrivacyRepository } from '@aramo/sign';

import { PlatformPrivacyRequestsController } from '../app/platform/platform-privacy-requests.controller.js';

// Aramo-Sign-Mobile-Amendment-M-A7 §3 — the privacy team's operator actions. The
// staged deletion is never authorized while SIGN_PRIVACY_DELETION_EXECUTION_ENABLED is
// off, never under legal hold, never without an inventoried account, and only for a
// DELETION; every route is platform-consumer only.

const FLAG = 'SIGN_PRIVACY_DELETION_EXECUTION_ENABLED';
const auth = (consumer_type = 'platform') => ({ sub: '01900000-0000-7000-8000-00000000e0aa', consumer_type }) as unknown as AuthContextType;

function record(over: Partial<PrivacyRequestRecord> = {}): PrivacyRequestRecord {
  const now = new Date();
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
    contact_email_hash: null,
    contact_email_ciphertext: null,
    due_at: new Date(now.getTime() + 1000),
    assigned_operator_id: null,
    inventory: null,
    completion_evidence: null,
    outcome_code: null,
    outcome_text: null,
    identity_validated_at: now,
    completed_at: null,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

function setup(rec: PrivacyRequestRecord, legal_hold = false) {
  const requests = {
    findById: vi.fn(async () => rec),
    transition: vi.fn(async (_id: string, to: string) => ({ ...rec, status: to })),
    view: vi.fn((r: PrivacyRequestRecord) => ({ reference: r.reference, status: r.status })),
  } as unknown as PrivacyRequestService;
  const subjects = { context: vi.fn(async () => ({ legal_hold })) } as unknown as PrivacySubjectService;
  const ctl = new PlatformPrivacyRequestsController(requests, subjects, {} as SignPrivacyRepository);
  return { ctl, requests };
}

describe('platform privacy-request operator actions (M-A7 §3)', () => {
  afterEach(() => {
    delete process.env[FLAG];
  });

  it('execute is refused while staged execution is OFF (the default)', async () => {
    const { ctl, requests } = setup(record());
    await expect(ctl.execute('r1', { note: 'ok' }, auth(), 'rq')).rejects.toMatchObject({ statusCode: 409, context: { details: { reason: 'privacy_execution_disabled' } } });
    expect(requests.transition).not.toHaveBeenCalled();
  });

  it('execute is refused under legal hold, without an account subject, and for a non-deletion', async () => {
    process.env[FLAG] = '1';
    const held = setup(record(), true);
    await expect(held.ctl.execute('r1', { note: 'ok' }, auth(), 'rq')).rejects.toMatchObject({ context: { details: { reason: 'privacy_legal_hold' } } });
    const none = setup(record({ subject_user_id: null, subject_tenant_id: null }));
    await expect(none.ctl.execute('r1', { note: 'ok' }, auth(), 'rq')).rejects.toMatchObject({ context: { details: { reason: 'privacy_no_account_subject' } } });
    const access = setup(record({ request_type: 'ACCESS' }));
    await expect(access.ctl.execute('r1', { note: 'ok' }, auth(), 'rq')).rejects.toMatchObject({ context: { details: { reason: 'privacy_not_executable' } } });
  });

  it('execute moves an inventoried deletion to EXECUTING with the operator as actor when enabled', async () => {
    process.env[FLAG] = '1';
    const { ctl, requests } = setup(record());
    const out = await ctl.execute('r1', { note: 'verified' }, auth(), 'rq');
    expect(out.status).toBe('EXECUTING');
    expect(requests.transition).toHaveBeenCalledWith('r1', 'EXECUTING', { actor_type: 'OPERATOR', actor_id: auth().sub }, expect.objectContaining({ from: ['DATA_INVENTORY', 'REFERRED_TO_ORGANIZATION'] }));
  });

  it('every route is platform-consumer only', async () => {
    const { ctl } = setup(record());
    await expect(ctl.detail('r1', auth('sign'), 'rq')).rejects.toMatchObject({ statusCode: 403 });
    await expect(ctl.deny('r1', { note: 'x' }, auth('recruiter'), 'rq')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('an executing deletion completes itself; the operator cannot complete it by hand', async () => {
    const { ctl } = setup(record({ status: 'EXECUTING' }));
    await expect(ctl.complete('r1', { note: 'done' }, auth(), 'rq')).rejects.toMatchObject({ context: { details: { reason: 'privacy_execution_in_progress' } } });
  });
});
