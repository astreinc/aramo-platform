import { describe, expect, it, vi } from 'vitest';
import type { IdentityRepository, IdentityService, PersonalRiskService, TenantRepository } from '@aramo/identity';

import { SignAccountService } from '../app/account/sign-account.service.js';

// Aramo Sign Personal (Free) — Settings → Close account: the service rules with
// the identity collaborators stubbed (the real close runs in the integration spec).

const TENANT = '01900000-0000-7000-8000-0000000000a1';
const USER = '01900000-0000-7000-8000-0000000000b1';
const AUTH = { tenant_id: TENANT, sub: USER };
const T0 = new Date('2026-10-22T10:00:00.000Z');

function make(opts: { kind?: string | null; roles?: string[]; membershipActive?: boolean; state?: string | null; closeThrows?: boolean } = {}) {
  const kind = opts.kind === undefined ? 'PERSONAL' : opts.kind;
  let state = opts.state === undefined ? 'clear' : opts.state;
  const tenants = { findById: vi.fn(async () => (kind === null ? null : { id: TENANT, kind })) } as unknown as TenantRepository;
  const repo = {
    findMembership: vi.fn(async () => (opts.membershipActive === undefined || opts.membershipActive ? { id: 'm1', is_active: true } : { id: 'm1', is_active: false })),
  } as unknown as IdentityRepository;
  const identity = { findRoleKeysForMembership: vi.fn(async () => opts.roles ?? ['tenant_owner']) } as unknown as IdentityService;
  const close = vi.fn(async () => {
    if (opts.closeThrows) {
      state = 'closed';
      throw new Error('illegal_risk_transition');
    }
    state = 'closed';
    return { state: 'closed', updated_at: T0 };
  });
  const risk = {
    riskStateOf: vi.fn(async () => (state === null ? null : { state, updated_at: T0 })),
    close,
  } as unknown as PersonalRiskService;
  return { svc: new SignAccountService(tenants, repo, identity, risk), close };
}

const reasonOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return { status: (e as { statusCode?: number }).statusCode, reason: (e as { context?: { details?: { reason?: string } } }).context?.details?.reason };
  }
  return null;
};

describe('SignAccountService', () => {
  it('status: the owner of an open Personal account may close it; others may not; a closed account says so', async () => {
    expect(await make().svc.status(AUTH)).toEqual({ closable: true, closed: false, closed_at: null });
    expect(await make({ roles: ['sign_sender'] }).svc.status(AUTH)).toEqual({ closable: false, closed: false, closed_at: null });
    expect(await make({ kind: 'BUSINESS' }).svc.status(AUTH)).toEqual({ closable: false, closed: false, closed_at: null });
    expect(await make({ state: null }).svc.status(AUTH)).toEqual({ closable: false, closed: false, closed_at: null });
    expect(await make({ state: 'closed' }).svc.status(AUTH)).toEqual({ closable: false, closed: true, closed_at: T0.toISOString() });
  });

  it('close requires confirm = CLOSE exactly and a short text reason', async () => {
    const { svc, close } = make();
    for (const body of [undefined, {}, { confirm: 'close' }, { confirm: 'CLOSE ' }, { confirm: true }]) {
      expect(await reasonOf(svc.close(AUTH, body as never, 'r'))).toEqual({ status: 400, reason: 'account_close_confirmation_required' });
    }
    expect(await reasonOf(svc.close(AUTH, { confirm: 'CLOSE', reason: 'x'.repeat(501) }, 'r'))).toEqual({ status: 400, reason: 'invalid_close_reason' });
    expect(await reasonOf(svc.close(AUTH, { confirm: 'CLOSE', reason: 7 }, 'r'))).toEqual({ status: 400, reason: 'invalid_close_reason' });
    expect(close).not.toHaveBeenCalled();
  });

  it('close refuses a Business account, a non-owner, an inactive membership and a Personal account with no risk state', async () => {
    expect(await reasonOf(make({ kind: 'BUSINESS' }).svc.close(AUTH, { confirm: 'CLOSE' }, 'r'))).toEqual({ status: 403, reason: 'business_account_close_via_organization' });
    expect(await reasonOf(make({ roles: ['tenant_admin'] }).svc.close(AUTH, { confirm: 'CLOSE' }, 'r'))).toEqual({ status: 403, reason: 'not_account_owner' });
    expect(await reasonOf(make({ membershipActive: false }).svc.close(AUTH, { confirm: 'CLOSE' }, 'r'))).toEqual({ status: 403, reason: 'not_account_owner' });
    expect(await reasonOf(make({ state: null }).svc.close(AUTH, { confirm: 'CLOSE' }, 'r'))).toEqual({ status: 404, reason: 'personal_account_not_closable' });
    expect(await reasonOf(make({ kind: null }).svc.close(AUTH, { confirm: 'CLOSE' }, 'r'))).toEqual({ status: 403, reason: 'tenant_unknown' });
  });

  it('close runs the identity close with the owner as actor and the note as audit evidence', async () => {
    const { svc, close } = make({ state: 'restricted' });
    expect(await svc.close(AUTH, { confirm: 'CLOSE', reason: '  moving on  ' }, 'r')).toEqual({ state: 'closed', closed_at: T0.toISOString() });
    expect(close).toHaveBeenCalledWith(TENANT, USER, 'owner_closed', expect.any(Date), { closed_by: 'owner', note: 'moving on' });
  });

  it('closing a closed account answers its closed state without a second close; a lost race answers closed too', async () => {
    const closed = make({ state: 'closed' });
    expect(await closed.svc.close(AUTH, { confirm: 'CLOSE' }, 'r')).toEqual({ state: 'closed', closed_at: T0.toISOString() });
    expect(closed.close).not.toHaveBeenCalled();
    const raced = make({ closeThrows: true });
    expect(await raced.svc.close(AUTH, { confirm: 'CLOSE' }, 'r')).toEqual({ state: 'closed', closed_at: T0.toISOString() });
  });
});
