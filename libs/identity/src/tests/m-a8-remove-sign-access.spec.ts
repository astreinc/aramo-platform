import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';
import type { MailerPort } from '@aramo/mailer';

import type { IdentityAuditService } from '../lib/audit/identity-audit.service.js';
import type { IdentityService } from '../lib/identity.service.js';
import { TenantUserLifecycleService } from '../lib/tenant-user/tenant-user-lifecycle.service.js';
import { TenantUserManagementController } from '../lib/tenant-user/tenant-user-management.controller.js';
import type { TenantCognitoPort } from '../lib/tenant-user/tenant-cognito.port.js';
import type { AuditFinancialsGate } from '../lib/tenant-user/audit-financials-gate.port.js';

// Aramo-Sign-Mobile-Amendment-M-A8 §2.3 — remove Sign access: the controller/service
// boundary (the real-Postgres proof is m-a8-remove-sign-access.integration.spec.ts).

const TENANT = '01900000-0000-7000-8000-0000000000a1';
const ACTOR = '01900000-0000-7000-8000-0000000000aa';
const USER = '01900000-0000-7000-8000-0000000000bb';

function make(opts: { membership?: { id: string } | null; roles?: string[] } = {}) {
  const removeProductAccess = vi.fn().mockResolvedValue({
    before_role_keys: ['recruiter', 'sign_sender'],
    removed_role_keys: ['sign_sender'],
    after_role_keys: ['recruiter'],
    refresh_tokens_revoked: 2,
    device_sessions_revoked: 1,
    changed: true,
  });
  const identity = {
    findMembership: vi.fn().mockResolvedValue(opts.membership === undefined ? { id: 'mem-1' } : opts.membership),
    findRoleKeysForMembership: vi.fn().mockResolvedValue(opts.roles ?? ['recruiter', 'sign_sender']),
    removeProductAccess,
  };
  const cognito = {
    adminCreateUser: vi.fn(),
    adminDeleteUser: vi.fn(),
    adminDisableUser: vi.fn(),
    adminEnableUser: vi.fn(),
  };
  const audit = { writeEvent: vi.fn() };
  const lifecycle = new TenantUserLifecycleService(
    identity as unknown as IdentityService,
    cognito as unknown as TenantCognitoPort,
    { isFinancialsAuditEnabled: vi.fn() } as unknown as AuditFinancialsGate,
    { send: vi.fn() } as unknown as MailerPort,
  );
  const ctl = new TenantUserManagementController(lifecycle, audit as unknown as IdentityAuditService, identity as unknown as IdentityService);
  return { identity, cognito, audit, ctl };
}

const auth = (tenant_id = TENANT): AuthContextType =>
  ({ sub: ACTOR, tenant_id, scopes: ['tenant:admin:user-manage'], consumer_type: 'org' }) as unknown as AuthContextType;

describe('M-A8 §2.3 — DELETE /v1/tenant/users/:user_id/products/sign', () => {
  it('removes only the Sign role keys and revokes the Sign consumers, in the caller’s tenant; no Cognito call; the audit row is written in the repository transaction (not the two-call seam)', async () => {
    const m = make();
    const res = await m.ctl.removeSignAccess(auth(), USER, 'rq-1');
    expect(res).toEqual({
      membership_id: 'mem-1',
      product: 'sign',
      removed_role_keys: ['sign_sender'],
      after_role_keys: ['recruiter'],
      refresh_tokens_revoked: 2,
      device_sessions_revoked: 1,
      changed: true,
    });
    expect(m.identity.findMembership).toHaveBeenCalledWith({ user_id: USER, tenant_id: TENANT });
    expect(m.identity.removeProductAccess).toHaveBeenCalledWith({
      membership_id: 'mem-1',
      tenant_id: TENANT,
      user_id: USER,
      product: 'sign',
      role_keys: ['sign_admin', 'sign_sender', 'sign_viewer'],
      refresh_consumers: ['sign', 'sign_native'],
      native_consumer: 'sign',
      actor_user_id: ACTOR,
      request_id: 'rq-1',
    });
    expect(Object.values(m.cognito).every((f) => f.mock.calls.length === 0)).toBe(true);
    expect(m.audit.writeEvent).not.toHaveBeenCalled();
  });

  it('no membership in the caller’s tenant → 404 NOT_FOUND, nothing removed', async () => {
    const m = make({ membership: null });
    await expect(m.ctl.removeSignAccess(auth(), USER, 'rq-2')).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(m.identity.removeProductAccess).not.toHaveBeenCalled();
  });

  it.each([['tenant_owner'], ['tenant_admin']])('a %s holder keeps Sign through the organization role → 400 sign_access_via_organization_role, nothing removed', async (role) => {
    const m = make({ roles: [role, 'sign_sender'] });
    await expect(m.ctl.removeSignAccess(auth(), USER, 'rq-3')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      context: { details: { reason: 'sign_access_via_organization_role', role_keys: [role] } },
    });
    expect(m.identity.removeProductAccess).not.toHaveBeenCalled();
  });
});
