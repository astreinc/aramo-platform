import { describe, expect, it, vi } from 'vitest';
import type { MailerPort } from '@aramo/mailer';

import type { UserDto } from '../lib/dto/user.dto.js';
import type { IdentityService } from '../lib/identity.service.js';
import type { TenantCognitoPort } from '../lib/tenant-user/tenant-cognito.port.js';
import type { AuditFinancialsGate } from '../lib/tenant-user/audit-financials-gate.port.js';
import { TenantUserLifecycleService } from '../lib/tenant-user/tenant-user-lifecycle.service.js';

// Settings S3a — TenantUserLifecycleService saga proofs.
//
// D-AUTHZ-PLATFORM-INVITE-1 update (Gate-6, in-service ruling):
// RoleBundleValidator is no longer a dependency of the lifecycle service —
// the D5 union-non-invertibility check moved INTO IdentityService's write
// methods. Tests that previously asserted the LIFECYCLE called the
// validator have been rewritten to either (a) prove the lifecycle no
// longer touches a validator (its constructor signature has shrunk) or
// (b) assert the rejection by mocking IdentityService.* to throw — the
// rejection now surfaces from inside the IdentityService mock, exactly
// the way it would surface from the real IdentityService at runtime.
// The safe-by-construction proofs (the D5 check actually firing inside
// IdentityService) live in identity.service.spec.ts.
//
// The cross-store saga + compensation. Mocks IdentityService +
// TenantCognitoPort + AuditFinancialsGate; asserts:
//   INVITE:
//     - empty role_keys → 400 VALIDATION_ERROR (no Cognito call)
//     - identity-tx VALIDATION_ERROR (invertible union surfacing from
//       IdentityService.createUserFromInvitation) → Cognito rollback
//     - Cognito failure on step 1 → 502 COGNITO_PROVISION_FAILED, no
//       identity-tx, no rollback (Cognito never persisted)
//     - identity-tx failure post-Cognito → re-throw + adminDeleteUser
//       called (Cognito rollback)
//     - happy path → returns user + membership_id + cognito_sub
//   DISABLE:
//     - user not found → 404 NOT_FOUND, no flip, no Cognito
//     - membership not found → 404 NOT_FOUND, identity-side returned null
//     - already-disabled (idempotent) → no Cognito call, no audit needed
//     - happy path → flip + Cognito + return changed=true
//     - Cognito failure on step 2 → re-enable compensation + 502 thrown
//     - no-auto-reassign: the saga does NOT call any UserClientAssignment
//       / ManagementEdge / Team-related identity service method

const REQUEST_ID = 'rq-s3a-001';
const TENANT_ID = '01900000-0000-7000-8000-000000000001';
const ACTOR_ID = '01900000-0000-7000-8000-0000000000aa';
const USER_ID = '01900000-0000-7000-8000-0000000000bb';
const EMAIL = 'invitee@aramo.dev';

function makeUserDto(): UserDto {
  return {
    id: USER_ID,
    email: EMAIL,
    display_name: 'Invitee Person',
    is_active: true,
    deactivated_at: null,
    created_at: '2026-06-05T00:00:00.000Z',
    updated_at: '2026-06-05T00:00:00.000Z',
  };
}

interface Mocks {
  identitySvc: {
    resolveRoleIdsByKeys: ReturnType<typeof vi.fn>;
    // Invite-S2 — the no-sub create + token issue (replaces the old
    // Cognito-first createUserFromInvitation on the tenant invite path).
    createInvitedUserNoSub: ReturnType<typeof vi.fn>;
    getTenantLabel: ReturnType<typeof vi.fn>;
    findUserById: ReturnType<typeof vi.fn>;
    disableMembership: ReturnType<typeof vi.fn>;
    reEnableMembership: ReturnType<typeof vi.fn>;
    findMembership: ReturnType<typeof vi.fn>;
    findRoleKeysForMembership: ReturnType<typeof vi.fn>;
    replaceMembershipRoles: ReturnType<typeof vi.fn>;
    // Invite-S3 — the state-dependent action primitives.
    findActiveInvitation: ReturnType<typeof vi.fn>;
    revokeInvitation: ReturnType<typeof vi.fn>;
    rotateInvitationToken: ReturnType<typeof vi.fn>;
    updateUserEmail: ReturnType<typeof vi.fn>;
  };
  cognito: {
    adminCreateUser: ReturnType<typeof vi.fn>;
    adminDeleteUser: ReturnType<typeof vi.fn>;
    adminDisableUser: ReturnType<typeof vi.fn>;
    adminEnableUser: ReturnType<typeof vi.fn>;
  };
  auditFinancialsGate: {
    isFinancialsAuditEnabled: ReturnType<typeof vi.fn>;
  };
  mailer: {
    send: ReturnType<typeof vi.fn>;
  };
  service: TenantUserLifecycleService;
}

function makeMocks(): Mocks {
  const identitySvc = {
    resolveRoleIdsByKeys: vi.fn(),
    createInvitedUserNoSub: vi.fn(),
    getTenantLabel: vi.fn().mockResolvedValue('Astre'),
    findUserById: vi.fn(),
    disableMembership: vi.fn(),
    reEnableMembership: vi.fn(),
    findMembership: vi.fn(),
    findRoleKeysForMembership: vi.fn(),
    replaceMembershipRoles: vi.fn(),
    findActiveInvitation: vi.fn(),
    revokeInvitation: vi.fn().mockResolvedValue({ changed: true }),
    rotateInvitationToken: vi
      .fn()
      .mockResolvedValue({ raw_token: 'rotated-token', expires_at: 'x' }),
    updateUserEmail: vi.fn().mockResolvedValue(undefined),
  };
  const cognito = {
    adminCreateUser: vi.fn(),
    adminDeleteUser: vi.fn().mockResolvedValue(undefined),
    adminDisableUser: vi.fn(),
    adminEnableUser: vi.fn(),
  };
  // Settings S4 — AuditFinancialsGate port mock. Defaults to NOT-called
  // (the GATE precondition fires ONLY when the requested role-set
  // contains 'auditor_with_financials'); tests that exercise the gate
  // override the implementation explicitly.
  const auditFinancialsGate = {
    isFinancialsAuditEnabled: vi.fn().mockResolvedValue(false),
  };
  // Invite-S2 — the S1 mailer. Defaults to a successful send returning a
  // synthetic message id (matches StubMailerAdapter's shape).
  const mailer = {
    send: vi.fn().mockResolvedValue({ message_id: 'stub-msg-1' }),
  };
  const service = new TenantUserLifecycleService(
    identitySvc as unknown as IdentityService,
    cognito as unknown as TenantCognitoPort,
    auditFinancialsGate as unknown as AuditFinancialsGate,
    mailer as unknown as MailerPort,
  );
  return { identitySvc, cognito, auditFinancialsGate, mailer, service };
}

// Invite-S2 (Pattern-2) — the NO-SUB invite flow. The lifecycle no longer
// calls Cognito at invite time: createInvitedUserNoSub does the no-sub create
// + token issue (the D5 gate fires INSIDE it), then the invite email is sent
// via the S1 mailer. adminCreateUser is RETAINED in the adapter but NEVER
// called by invite.
describe('TenantUserLifecycleService.inviteTenantUser', () => {
  it('empty role_keys → VALIDATION_ERROR (no create, no Cognito, no email)', async () => {
    const { service, cognito, identitySvc, mailer } = makeMocks();
    await expect(
      service.inviteTenantUser({
        tenant_id: TENANT_ID,
        email: EMAIL,
        display_name: null,
        role_keys: [],
        actor_user_id: ACTOR_ID,
        request_id: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      context: { details: { reason: 'empty_role_keys' } },
    });
    expect(identitySvc.createInvitedUserNoSub).not.toHaveBeenCalled();
    expect(cognito.adminCreateUser).not.toHaveBeenCalled();
    expect(mailer.send).not.toHaveBeenCalled();
  });

  // The D5 union-non-invertibility check lives INSIDE createInvitedUserNoSub
  // (REUSED from createUserFromInvitation). The lifecycle surfaces the
  // rejection unchanged. Unlike the old Cognito-first saga there is NO
  // external side effect to roll back — no Cognito user is ever created, so
  // an invertible bundle rejects with ZERO external footprint.
  it('invertible role union → VALIDATION_ERROR surfaces from createInvitedUserNoSub; no Cognito, no email', async () => {
    const { service, cognito, identitySvc, mailer } = makeMocks();
    identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['rid-1', 'rid-2']);
    identitySvc.createInvitedUserNoSub.mockRejectedValue(
      Object.assign(new Error('invertible'), {
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        context: {
          requestId: REQUEST_ID,
          details: { reason: 'invertible_role_union' },
        },
      }),
    );
    await expect(
      service.inviteTenantUser({
        tenant_id: TENANT_ID,
        email: EMAIL,
        display_name: null,
        role_keys: ['rA', 'rB'],
        actor_user_id: ACTOR_ID,
        request_id: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'invertible_role_union' } },
    });
    // ZERO external footprint — the Pattern-2 invite never touches Cognito.
    expect(cognito.adminCreateUser).not.toHaveBeenCalled();
    expect(cognito.adminDeleteUser).not.toHaveBeenCalled();
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('happy path → no-sub create + token, invite email sent, returns INVITED + invitation_id (NEVER calls Cognito)', async () => {
    const { service, cognito, identitySvc, mailer } = makeMocks();
    identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['rid-1', 'rid-2']);
    identitySvc.createInvitedUserNoSub.mockResolvedValue({
      user: makeUserDto(),
      membership_id: 'mem-1',
      invitation_id: 'inv-1',
      raw_token: 'raw-token-xyz',
      expires_at: '2026-07-01T00:00:00.000Z',
    });
    const result = await service.inviteTenantUser({
      tenant_id: TENANT_ID,
      email: EMAIL,
      display_name: 'Invitee Person',
      role_keys: ['rA', 'rB'],
      actor_user_id: ACTOR_ID,
      request_id: REQUEST_ID,
    });
    // New response shape — cognito_sub gone, state + invitation_id added.
    expect(result).toEqual({
      user: makeUserDto(),
      membership_id: 'mem-1',
      invite_status: 'INVITED',
      invitation_id: 'inv-1',
    });
    expect(identitySvc.createInvitedUserNoSub).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TENANT_ID,
        actor_user_id: ACTOR_ID,
        email: EMAIL,
        role_keys: ['rA', 'rB'],
        role_ids: ['rid-1', 'rid-2'],
        request_id: REQUEST_ID,
      }),
    );
    // The invite path NEVER mints a Cognito user (Pattern-2).
    expect(cognito.adminCreateUser).not.toHaveBeenCalled();
    expect(cognito.adminDeleteUser).not.toHaveBeenCalled();
    // The invite email was sent to the invitee, carrying the raw token link.
    expect(mailer.send).toHaveBeenCalledTimes(1);
    const sent = mailer.send.mock.calls[0]![0] as {
      to: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(sent.to).toBe(EMAIL);
    expect(sent.html).toContain('raw-token-xyz');
    expect(sent.text).toContain('raw-token-xyz');
  });

  it('email send failure does NOT fail the invite (best-effort; the record + token already committed)', async () => {
    const { service, identitySvc, mailer } = makeMocks();
    identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['rid-1']);
    identitySvc.createInvitedUserNoSub.mockResolvedValue({
      user: makeUserDto(),
      membership_id: 'mem-1',
      invitation_id: 'inv-1',
      raw_token: 'raw-token-xyz',
      expires_at: '2026-07-01T00:00:00.000Z',
    });
    mailer.send.mockRejectedValue(new Error('SES unavailable'));
    const result = await service.inviteTenantUser({
      tenant_id: TENANT_ID,
      email: EMAIL,
      display_name: null,
      role_keys: ['rA'],
      actor_user_id: ACTOR_ID,
      request_id: REQUEST_ID,
    });
    // The invite still SUCCEEDS — the user + token persisted; resend covers
    // the missed email.
    expect(result).toMatchObject({
      membership_id: 'mem-1',
      invite_status: 'INVITED',
      invitation_id: 'inv-1',
    });
    expect(mailer.send).toHaveBeenCalled();
  });
});

describe('TenantUserLifecycleService.disableTenantUser', () => {
  it('user not found → 404 NOT_FOUND; no flip, no Cognito', async () => {
    const { service, cognito, identitySvc } = makeMocks();
    identitySvc.findUserById.mockResolvedValue(null);
    await expect(
      service.disableTenantUser({
        tenant_id: TENANT_ID,
        user_id: USER_ID,
        actor_user_id: ACTOR_ID,
        reason: null,
        request_id: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(identitySvc.disableMembership).not.toHaveBeenCalled();
    expect(cognito.adminDisableUser).not.toHaveBeenCalled();
  });

  it('membership not found in this tenant → 404 NOT_FOUND (per-tenant isolation)', async () => {
    const { service, cognito, identitySvc } = makeMocks();
    identitySvc.findUserById.mockResolvedValue(makeUserDto());
    identitySvc.disableMembership.mockResolvedValue(null);
    await expect(
      service.disableTenantUser({
        tenant_id: TENANT_ID,
        user_id: USER_ID,
        actor_user_id: ACTOR_ID,
        reason: null,
        request_id: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(cognito.adminDisableUser).not.toHaveBeenCalled();
  });

  it('idempotent — already disabled → no Cognito call, returns changed=false', async () => {
    const { service, cognito, identitySvc } = makeMocks();
    identitySvc.findUserById.mockResolvedValue(makeUserDto());
    identitySvc.disableMembership.mockResolvedValue({
      changed: false,
      membership_id: 'mem-1',
      already_disabled: true,
    });
    const result = await service.disableTenantUser({
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      actor_user_id: ACTOR_ID,
      reason: null,
      request_id: REQUEST_ID,
    });
    expect(result).toEqual({
      membership_id: 'mem-1',
      changed: false,
      already_disabled: true,
    });
    expect(cognito.adminDisableUser).not.toHaveBeenCalled();
  });

  it('happy path → identity flip then Cognito disable; returns changed=true', async () => {
    const { service, cognito, identitySvc } = makeMocks();
    identitySvc.findUserById.mockResolvedValue(makeUserDto());
    identitySvc.disableMembership.mockResolvedValue({
      changed: true,
      membership_id: 'mem-1',
    });
    cognito.adminDisableUser.mockResolvedValue(undefined);
    const result = await service.disableTenantUser({
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      actor_user_id: ACTOR_ID,
      reason: 'departed',
      request_id: REQUEST_ID,
    });
    expect(result).toEqual({
      membership_id: 'mem-1',
      changed: true,
      already_disabled: false,
    });
    // Cognito called with the user's email (looked up via findUserById,
    // NOT trusted from the caller — per-tenant isolation discipline).
    expect(cognito.adminDisableUser).toHaveBeenCalledWith({ email: EMAIL });
    // Re-enable compensation NOT called on success.
    expect(identitySvc.reEnableMembership).not.toHaveBeenCalled();
  });

  it('Cognito disable failure → re-enable compensation + 502 COGNITO_PROVISION_FAILED', async () => {
    const { service, cognito, identitySvc } = makeMocks();
    identitySvc.findUserById.mockResolvedValue(makeUserDto());
    identitySvc.disableMembership.mockResolvedValue({
      changed: true,
      membership_id: 'mem-1',
    });
    cognito.adminDisableUser.mockRejectedValue(new Error('cognito disable boom'));
    identitySvc.reEnableMembership.mockResolvedValue({ membership_id: 'mem-1' });
    await expect(
      service.disableTenantUser({
        tenant_id: TENANT_ID,
        user_id: USER_ID,
        actor_user_id: ACTOR_ID,
        reason: null,
        request_id: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: 'COGNITO_PROVISION_FAILED',
      statusCode: 502,
      context: { details: { compensation: 're_enabled' } },
    });
    expect(identitySvc.reEnableMembership).toHaveBeenCalledWith({
      user_id: USER_ID,
      tenant_id: TENANT_ID,
    });
  });

  it('no-auto-reassign — saga only flips membership; never touches assignments / edges / teams', async () => {
    // Structural proof: the IdentityService spy surface lists every method
    // the saga is allowed to reach. The saga's happy path must NOT touch
    // any UserClientAssignment / ManagementEdge / TeamMembership method.
    // The mock object's keys are the exhaustive allowed surface.
    const { service, identitySvc, cognito } = makeMocks();
    identitySvc.findUserById.mockResolvedValue(makeUserDto());
    identitySvc.disableMembership.mockResolvedValue({
      changed: true,
      membership_id: 'mem-1',
    });
    cognito.adminDisableUser.mockResolvedValue(undefined);
    await service.disableTenantUser({
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      actor_user_id: ACTOR_ID,
      reason: null,
      request_id: REQUEST_ID,
    });
    // Confirm the allowed methods alone were touched. Any new mock-method
    // hit (e.g. an accidental call into ManagementEdgeService.unset) would
    // require expanding the mock surface — making the boundary breach
    // explicit at test-author time.
    const surface = identitySvc as unknown as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    const calledMethods = Object.keys(surface).filter((k) => {
      const fn = surface[k];
      return fn !== undefined && fn.mock.calls.length > 0;
    });
    expect(calledMethods.sort()).toEqual(['disableMembership', 'findUserById']);
  });
});

// Settings S3b — assignTenantUserRoles saga proofs.
//
// The D5-integrity surface. Mocks the merged RoleBundleValidator + the
// merged IdentityService primitives (resolveRoleIdsByKeys + findMembership +
// findRoleKeysForMembership + replaceMembershipRoles) and asserts:
//   - empty role_keys → 400 VALIDATION_ERROR (no DB call, no reconcile)
//   - unknown role_key → VALIDATION_ERROR (via resolveRoleIdsByKeys; no
//     reconcile)
//   - INVERTIBLE union → VALIDATION_ERROR (the load-bearing D5 rejection,
//     write-time BEFORE the reconcile so the invertible bundle NEVER
//     persists)
//   - membership not found (user has no membership in this tenant) → 404
//     NOT_FOUND, no reconcile
//   - happy path → reconcile + correct before/after/added/removed key
//     sets (sorted)
//   - empty delta (PATCH with the same role-set as current) → adds+removes
//     both empty; the controller will then suppress both audit events
//   - implicit-tenant: findMembership called with authContext.tenant_id

const MEMBERSHIP_ID = '01900000-0000-7000-8000-0000000000cc';

describe('TenantUserLifecycleService.assignTenantUserRoles', () => {
  it('empty role_keys → VALIDATION_ERROR; no DB call', async () => {
    const { service, identitySvc } = makeMocks();
    await expect(
      service.assignTenantUserRoles({
        tenant_id: TENANT_ID,
        user_id: USER_ID,
        role_keys: [],
        actor_user_id: ACTOR_ID,
        request_id: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      context: { details: { reason: 'empty_role_keys' } },
    });
    expect(identitySvc.resolveRoleIdsByKeys).not.toHaveBeenCalled();
    expect(identitySvc.replaceMembershipRoles).not.toHaveBeenCalled();
  });

  it('unknown role_key → VALIDATION_ERROR; no reconcile', async () => {
    const { service, identitySvc } = makeMocks();
    identitySvc.resolveRoleIdsByKeys.mockRejectedValue(
      Object.assign(new Error('Unknown role key(s)'), {
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        context: {
          requestId: REQUEST_ID,
          details: { missing_role_keys: ['bogus'] },
        },
      }),
    );
    await expect(
      service.assignTenantUserRoles({
        tenant_id: TENANT_ID,
        user_id: USER_ID,
        role_keys: ['bogus'],
        actor_user_id: ACTOR_ID,
        request_id: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(identitySvc.replaceMembershipRoles).not.toHaveBeenCalled();
  });

  // D-AUTHZ-PLATFORM-INVITE-1: the D5 union-non-invertibility check moved
  // INTO IdentityService.replaceMembershipRoles. Re-ordering note: the
  // membership lookup + findRoleKeysForMembership now run BEFORE the
  // validator (which fires inside replaceMembershipRoles). The lifecycle
  // surfaces the rejection unchanged; the safe-by-construction proof
  // (the validator's actual short-circuit inside the $transaction
  // boundary) lives in identity.service.spec.ts.
  it('INVERTIBLE union → 400 surfaces from replaceMembershipRoles; the reconcile is reached but the validator inside it short-circuits before any DB write', async () => {
    const { service, identitySvc } = makeMocks();
    identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['rid-pay', 'rid-spr']);
    identitySvc.findMembership.mockResolvedValue({ id: MEMBERSHIP_ID });
    identitySvc.findRoleKeysForMembership.mockResolvedValue([]);
    identitySvc.replaceMembershipRoles.mockRejectedValue(
      Object.assign(new Error('invertible'), {
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        context: {
          requestId: REQUEST_ID,
          details: {
            reason: 'invertible_role_union',
            role_keys: ['view_pay', 'view_spread'],
          },
        },
      }),
    );
    await expect(
      service.assignTenantUserRoles({
        tenant_id: TENANT_ID,
        user_id: USER_ID,
        role_keys: ['view_pay', 'view_spread'],
        actor_user_id: ACTOR_ID,
        request_id: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'invertible_role_union' } },
    });
    // The reconcile method WAS called (new ordering) but the validator
    // inside it threw before the createMany/deleteMany — proven in
    // identity.service.spec.ts safe-by-construction suite.
    expect(identitySvc.replaceMembershipRoles).toHaveBeenCalledWith(
      expect.objectContaining({
        membership_id: MEMBERSHIP_ID,
        role_keys: ['view_pay', 'view_spread'],
        role_ids: ['rid-pay', 'rid-spr'],
        request_id: REQUEST_ID,
      }),
    );
  });

  it('membership not found in this tenant → 404 NOT_FOUND; no reconcile', async () => {
    const { service, identitySvc } = makeMocks();
    identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['rid-1']);
    identitySvc.findMembership.mockResolvedValue(null);
    await expect(
      service.assignTenantUserRoles({
        tenant_id: TENANT_ID,
        user_id: USER_ID,
        role_keys: ['recruiter'],
        actor_user_id: ACTOR_ID,
        request_id: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(identitySvc.replaceMembershipRoles).not.toHaveBeenCalled();
  });

  it('happy path with both adds AND removes → correct deltas (sorted)', async () => {
    const { service, identitySvc } = makeMocks();
    identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['rid-am', 'rid-rc']);
    identitySvc.findMembership.mockResolvedValue({ id: MEMBERSHIP_ID });
    identitySvc.findRoleKeysForMembership.mockResolvedValue([
      'recruiter',
      'sourcer',
    ]);
    identitySvc.replaceMembershipRoles.mockResolvedValue({
      added_role_ids: ['rid-am'],
      removed_role_ids: ['rid-sourcer'],
    });
    const result = await service.assignTenantUserRoles({
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      role_keys: ['account_manager', 'recruiter'],
      actor_user_id: ACTOR_ID,
      request_id: REQUEST_ID,
    });
    expect(result.membership_id).toBe(MEMBERSHIP_ID);
    expect(result.before_role_keys).toEqual(['recruiter', 'sourcer']);
    expect(result.after_role_keys).toEqual(['account_manager', 'recruiter']);
    expect(result.added_role_keys).toEqual(['account_manager']);
    expect(result.removed_role_keys).toEqual(['sourcer']);
    // D-AUTHZ-PLATFORM-INVITE-1: the D5 gate fires INSIDE
    // replaceMembershipRoles (not before it in the lifecycle); the
    // safe-by-construction proof lives in identity.service.spec.ts.
    // Here we verify the lifecycle threads role_keys + request_id
    // through so the in-service check has its inputs.
    expect(identitySvc.replaceMembershipRoles).toHaveBeenCalledWith({
      membership_id: MEMBERSHIP_ID,
      role_keys: ['account_manager', 'recruiter'],
      role_ids: ['rid-am', 'rid-rc'],
      request_id: REQUEST_ID,
    });
  });

  it('empty delta (PATCH with current role-set) → adds+removes both empty', async () => {
    const { service, identitySvc } = makeMocks();
    identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['rid-rc']);
    identitySvc.findMembership.mockResolvedValue({ id: MEMBERSHIP_ID });
    identitySvc.findRoleKeysForMembership.mockResolvedValue(['recruiter']);
    identitySvc.replaceMembershipRoles.mockResolvedValue({
      added_role_ids: [],
      removed_role_ids: [],
    });
    const result = await service.assignTenantUserRoles({
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      role_keys: ['recruiter'],
      actor_user_id: ACTOR_ID,
      request_id: REQUEST_ID,
    });
    expect(result.added_role_keys).toEqual([]);
    expect(result.removed_role_keys).toEqual([]);
    expect(result.before_role_keys).toEqual(['recruiter']);
    expect(result.after_role_keys).toEqual(['recruiter']);
  });

  it('per-tenant isolation: findMembership is called with authContext.tenant_id', async () => {
    const { service, identitySvc } = makeMocks();
    identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['rid-rc']);
    identitySvc.findMembership.mockResolvedValue({ id: MEMBERSHIP_ID });
    identitySvc.findRoleKeysForMembership.mockResolvedValue([]);
    identitySvc.replaceMembershipRoles.mockResolvedValue({
      added_role_ids: ['rid-rc'],
      removed_role_ids: [],
    });
    await service.assignTenantUserRoles({
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      role_keys: ['recruiter'],
      actor_user_id: ACTOR_ID,
      request_id: REQUEST_ID,
    });
    expect(identitySvc.findMembership).toHaveBeenCalledWith({
      user_id: USER_ID,
      tenant_id: TENANT_ID,
    });
  });
});

// Settings S4 — assignTenantUserRoles + the auditor_with_financials GATE
// precondition.
//
// THE LOAD-BEARING S4 PROOFS (commit plan §4 (e) (f) (g)):
//   (e) the grant via S3b's PATCH when the toggle is ON   → succeeds
//   (f) the grant of auditor_with_financials when OFF      → REJECTED
//                                                            (VALIDATION_ERROR
//                                                            with details
//                                                            .reason=
//                                                            'financials_audit_
//                                                            not_enabled')
//   (g) the GATE is NARROW — assigning ANY OTHER role-set is
//       UNAFFECTED by audit.financials_enabled (S3b's general behavior
//       unchanged; the gate read is not invoked for non-target roles)

describe('TenantUserLifecycleService.assignTenantUserRoles — Settings S4 GATE precondition', () => {
  it('auditor_with_financials + toggle OFF → REJECTED (financials_audit_not_enabled); no reconcile', async () => {
    const { service, identitySvc, auditFinancialsGate } = makeMocks();
    identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['rid-awf']);
    auditFinancialsGate.isFinancialsAuditEnabled.mockResolvedValue(false);
    const promise = service.assignTenantUserRoles({
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      role_keys: ['auditor_with_financials'],
      actor_user_id: ACTOR_ID,
      request_id: REQUEST_ID,
    });
    await expect(promise).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      context: {
        requestId: REQUEST_ID,
        details: {
          reason: 'financials_audit_not_enabled',
          role_key: 'auditor_with_financials',
        },
      },
    });
    // The GATE fires WRITE-TIME, BEFORE any side effect.
    expect(auditFinancialsGate.isFinancialsAuditEnabled).toHaveBeenCalledWith(
      TENANT_ID,
    );
    expect(identitySvc.findMembership).not.toHaveBeenCalled();
    expect(identitySvc.replaceMembershipRoles).not.toHaveBeenCalled();
  });

  it('auditor_with_financials + toggle ON → succeeds (reconcile runs; gate consulted with tenant_id)', async () => {
    const { service, identitySvc, auditFinancialsGate } = makeMocks();
    identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['rid-awf']);
    auditFinancialsGate.isFinancialsAuditEnabled.mockResolvedValue(true);
    identitySvc.findMembership.mockResolvedValue({ id: MEMBERSHIP_ID });
    identitySvc.findRoleKeysForMembership.mockResolvedValue([]);
    identitySvc.replaceMembershipRoles.mockResolvedValue({
      added_role_ids: ['rid-awf'],
      removed_role_ids: [],
    });
    const result = await service.assignTenantUserRoles({
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      role_keys: ['auditor_with_financials'],
      actor_user_id: ACTOR_ID,
      request_id: REQUEST_ID,
    });
    expect(result.membership_id).toBe(MEMBERSHIP_ID);
    expect(result.added_role_keys).toEqual(['auditor_with_financials']);
    expect(result.removed_role_keys).toEqual([]);
    expect(auditFinancialsGate.isFinancialsAuditEnabled).toHaveBeenCalledWith(
      TENANT_ID,
    );
    // D-AUTHZ-PLATFORM-INVITE-1: the D5 union check now runs INSIDE
    // replaceMembershipRoles (the in-service ruling); the lifecycle
    // threads role_keys + request_id so the in-service validator has
    // its inputs. The validator's short-circuit at length<2 keeps the
    // single-role assignment zero-cost.
    expect(identitySvc.replaceMembershipRoles).toHaveBeenCalledWith({
      membership_id: MEMBERSHIP_ID,
      role_keys: ['auditor_with_financials'],
      role_ids: ['rid-awf'],
      request_id: REQUEST_ID,
    });
  });

  it('the GATE is NARROW — assigning recruiter (no auditor_with_financials) NEVER reads the toggle, regardless of its value', async () => {
    const { service, identitySvc, auditFinancialsGate } = makeMocks();
    identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['rid-rc']);
    // Toggle is OFF; if the GATE were a global precondition, this would
    // wrongly reject. The NARROW gate is keyed to the single role-key —
    // recruiter must flow through untouched.
    auditFinancialsGate.isFinancialsAuditEnabled.mockResolvedValue(false);
    identitySvc.findMembership.mockResolvedValue({ id: MEMBERSHIP_ID });
    identitySvc.findRoleKeysForMembership.mockResolvedValue([]);
    identitySvc.replaceMembershipRoles.mockResolvedValue({
      added_role_ids: ['rid-rc'],
      removed_role_ids: [],
    });
    const result = await service.assignTenantUserRoles({
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      role_keys: ['recruiter'],
      actor_user_id: ACTOR_ID,
      request_id: REQUEST_ID,
    });
    expect(result.added_role_keys).toEqual(['recruiter']);
    // THE NARROW INVARIANT — the gate is NEVER consulted for a non-
    // target role-set.
    expect(auditFinancialsGate.isFinancialsAuditEnabled).not.toHaveBeenCalled();
    // Reconcile still fires (D5 inside it — the in-service check).
    expect(identitySvc.replaceMembershipRoles).toHaveBeenCalled();
  });

  it('NARROW — assigning recruiter + sourcer (no auditor_with_financials in the set) NEVER reads the toggle', async () => {
    const { service, identitySvc, auditFinancialsGate } = makeMocks();
    identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['rid-rc', 'rid-srl']);
    auditFinancialsGate.isFinancialsAuditEnabled.mockResolvedValue(false);
    identitySvc.findMembership.mockResolvedValue({ id: MEMBERSHIP_ID });
    identitySvc.findRoleKeysForMembership.mockResolvedValue([]);
    identitySvc.replaceMembershipRoles.mockResolvedValue({
      added_role_ids: ['rid-rc', 'rid-srl'],
      removed_role_ids: [],
    });
    await service.assignTenantUserRoles({
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      role_keys: ['recruiter', 'sourcer'],
      actor_user_id: ACTOR_ID,
      request_id: REQUEST_ID,
    });
    expect(auditFinancialsGate.isFinancialsAuditEnabled).not.toHaveBeenCalled();
  });

  it('the GATE fires when auditor_with_financials sits ALONGSIDE other roles in the requested set (multi-role grant, toggle OFF)', async () => {
    const { service, identitySvc, auditFinancialsGate } = makeMocks();
    identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['rid-rc', 'rid-awf']);
    auditFinancialsGate.isFinancialsAuditEnabled.mockResolvedValue(false);
    const promise = service.assignTenantUserRoles({
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      role_keys: ['recruiter', 'auditor_with_financials'],
      actor_user_id: ACTOR_ID,
      request_id: REQUEST_ID,
    });
    await expect(promise).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'financials_audit_not_enabled' } },
    });
    expect(identitySvc.replaceMembershipRoles).not.toHaveBeenCalled();
  });

  it('unknown role_key (auditor_with_financials misspelled) → resolveRoleIdsByKeys throws FIRST; the gate is never consulted', async () => {
    // The GATE fires AFTER resolveRoleIdsByKeys (ordering preserved).
    // A misspelled key throws at the resolver before the gate read.
    const { service, identitySvc, auditFinancialsGate } = makeMocks();
    identitySvc.resolveRoleIdsByKeys.mockRejectedValue(
      Object.assign(new Error('Unknown role key(s)'), {
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        context: {
          requestId: REQUEST_ID,
          details: { missing_role_keys: ['auditor_with_financialz'] },
        },
      }),
    );
    await expect(
      service.assignTenantUserRoles({
        tenant_id: TENANT_ID,
        user_id: USER_ID,
        role_keys: ['auditor_with_financialz'],
        actor_user_id: ACTOR_ID,
        request_id: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(auditFinancialsGate.isFinancialsAuditEnabled).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Invite-S3 — the state-dependent lifecycle actions (§4). Proves the action
// gating mirrors the §0 displayed-status model and that each branch reaches
// the right primitive: enable (re-enable), revoke (invitation revoke +
// identity-only soft-disable, NO Cognito), resend (3 behaviors), edit-email
// (FAILED-only guard + uniqueness mapping).
// ──────────────────────────────────────────────────────────────────────────

function membership(overrides: {
  is_active: boolean;
  invite_status: string;
}): Record<string, unknown> {
  return {
    id: MEMBERSHIP_ID,
    user_id: USER_ID,
    tenant_id: TENANT_ID,
    site_id: null,
    is_active: overrides.is_active,
    invite_status: overrides.invite_status,
    joined_at: '2026-06-05T00:00:00.000Z',
    deactivated_at: null,
    created_at: '2026-06-05T00:00:00.000Z',
    updated_at: '2026-06-05T00:00:00.000Z',
  };
}

const INVITATION = {
  id: '01900000-0000-7000-8000-0000000000dd',
  user_id: USER_ID,
  tenant_id: TENANT_ID,
  membership_id: MEMBERSHIP_ID,
  expires_at: '2026-07-01T00:00:00.000Z',
  accepted_at: null,
  revoked_at: null,
  created_at: '2026-06-05T00:00:00.000Z',
  updated_at: '2026-06-05T00:00:00.000Z',
};

describe('TenantUserLifecycleService.enableTenantUser (§4.1)', () => {
  it('re-enables the membership (identity-only; no Cognito) and returns membership_id', async () => {
    const { service, identitySvc, cognito } = makeMocks();
    identitySvc.reEnableMembership.mockResolvedValue({
      membership_id: MEMBERSHIP_ID,
    });
    const result = await service.enableTenantUser({
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      request_id: REQUEST_ID,
    });
    expect(result).toEqual({ membership_id: MEMBERSHIP_ID });
    expect(identitySvc.reEnableMembership).toHaveBeenCalledWith({
      user_id: USER_ID,
      tenant_id: TENANT_ID,
    });
    // Identity-only — no Cognito leg.
    expect(cognito.adminEnableUser).not.toHaveBeenCalled();
  });

  it('no membership in this tenant → 404 NOT_FOUND', async () => {
    const { service, identitySvc } = makeMocks();
    identitySvc.reEnableMembership.mockResolvedValue(null);
    await expect(
      service.enableTenantUser({
        tenant_id: TENANT_ID,
        user_id: USER_ID,
        request_id: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });
});

describe('TenantUserLifecycleService.revokeTenantInvite (§4.2)', () => {
  it('INVITED → stamps invitation revoked + soft-disables membership (NO Cognito)', async () => {
    const { service, identitySvc, cognito } = makeMocks();
    identitySvc.findMembership.mockResolvedValue(
      membership({ is_active: true, invite_status: 'INVITED' }),
    );
    identitySvc.findActiveInvitation.mockResolvedValue(INVITATION);
    identitySvc.disableMembership.mockResolvedValue({
      changed: true,
      membership_id: MEMBERSHIP_ID,
    });
    const result = await service.revokeTenantInvite({
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      request_id: REQUEST_ID,
    });
    expect(result.revoked).toBe(true);
    expect(identitySvc.revokeInvitation).toHaveBeenCalledWith({
      invitation_id: INVITATION.id,
    });
    expect(identitySvc.disableMembership).toHaveBeenCalledWith({
      user_id: USER_ID,
      tenant_id: TENANT_ID,
    });
    // The revoke path NEVER touches Cognito (pending invitee has no sub).
    expect(cognito.adminDisableUser).not.toHaveBeenCalled();
  });

  it('ACTIVE → 4xx no_pending_invite (nothing to revoke); no writes', async () => {
    const { service, identitySvc } = makeMocks();
    identitySvc.findMembership.mockResolvedValue(
      membership({ is_active: true, invite_status: 'ACTIVE' }),
    );
    await expect(
      service.revokeTenantInvite({
        tenant_id: TENANT_ID,
        user_id: USER_ID,
        request_id: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      context: { details: { reason: 'no_pending_invite' } },
    });
    expect(identitySvc.revokeInvitation).not.toHaveBeenCalled();
    expect(identitySvc.disableMembership).not.toHaveBeenCalled();
  });

  it('INACTIVE → 4xx no_pending_invite', async () => {
    const { service, identitySvc } = makeMocks();
    identitySvc.findMembership.mockResolvedValue(
      membership({ is_active: false, invite_status: 'ACTIVE' }),
    );
    await expect(
      service.revokeTenantInvite({
        tenant_id: TENANT_ID,
        user_id: USER_ID,
        request_id: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      context: { details: { reason: 'no_pending_invite' } },
    });
  });

  it('no membership → 404 NOT_FOUND', async () => {
    const { service, identitySvc } = makeMocks();
    identitySvc.findMembership.mockResolvedValue(null);
    await expect(
      service.revokeTenantInvite({
        tenant_id: TENANT_ID,
        user_id: USER_ID,
        request_id: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });
});

describe('TenantUserLifecycleService.resendInvitation (§4.3 — 3 behaviors)', () => {
  it('INVITED → token-ROTATE + invitation email', async () => {
    const { service, identitySvc, mailer } = makeMocks();
    identitySvc.findMembership.mockResolvedValue(
      membership({ is_active: true, invite_status: 'INVITED' }),
    );
    identitySvc.findActiveInvitation.mockResolvedValue(INVITATION);
    identitySvc.findUserById.mockResolvedValue(makeUserDto());
    const result = await service.resendInvitation({
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      request_id: REQUEST_ID,
    });
    expect(result).toEqual({ sent: 'invitation' });
    expect(identitySvc.rotateInvitationToken).toHaveBeenCalledWith({
      invitation_id: INVITATION.id,
    });
    // The invitation email carries the freshly-rotated raw token.
    expect(mailer.send).toHaveBeenCalledTimes(1);
    const sent = mailer.send.mock.calls[0]![0] as { to: string; html: string };
    expect(sent.to).toBe(EMAIL);
    expect(sent.html).toContain('rotated-token');
  });

  it('ACCEPTED → confirmation email, NO token change', async () => {
    const { service, identitySvc, mailer } = makeMocks();
    identitySvc.findMembership.mockResolvedValue(
      membership({ is_active: true, invite_status: 'ACCEPTED' }),
    );
    identitySvc.findUserById.mockResolvedValue(makeUserDto());
    const result = await service.resendInvitation({
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      request_id: REQUEST_ID,
    });
    expect(result).toEqual({ sent: 'confirmation' });
    // No token rotation for an already-accepted invite.
    expect(identitySvc.rotateInvitationToken).not.toHaveBeenCalled();
    expect(mailer.send).toHaveBeenCalledTimes(1);
    // Confirmation email points at sign-in (no accept token).
    const sent = mailer.send.mock.calls[0]![0] as { html: string };
    expect(sent.html).not.toContain('rotated-token');
  });

  it('ACTIVE → 4xx no_pending_invite; no rotate, no email', async () => {
    const { service, identitySvc, mailer } = makeMocks();
    identitySvc.findMembership.mockResolvedValue(
      membership({ is_active: true, invite_status: 'ACTIVE' }),
    );
    await expect(
      service.resendInvitation({
        tenant_id: TENANT_ID,
        user_id: USER_ID,
        request_id: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'no_pending_invite' } },
    });
    expect(identitySvc.rotateInvitationToken).not.toHaveBeenCalled();
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('INACTIVE → 4xx no_pending_invite', async () => {
    const { service, identitySvc } = makeMocks();
    identitySvc.findMembership.mockResolvedValue(
      membership({ is_active: false, invite_status: 'INVITED' }),
    );
    await expect(
      service.resendInvitation({
        tenant_id: TENANT_ID,
        user_id: USER_ID,
        request_id: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      context: { details: { reason: 'no_pending_invite' } },
    });
  });

  it('email send failure is best-effort — the rotate still committed, request succeeds', async () => {
    const { service, identitySvc, mailer } = makeMocks();
    identitySvc.findMembership.mockResolvedValue(
      membership({ is_active: true, invite_status: 'INVITED' }),
    );
    identitySvc.findActiveInvitation.mockResolvedValue(INVITATION);
    identitySvc.findUserById.mockResolvedValue(makeUserDto());
    mailer.send.mockRejectedValue(new Error('SES down'));
    const result = await service.resendInvitation({
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      request_id: REQUEST_ID,
    });
    expect(result).toEqual({ sent: 'invitation' });
    expect(identitySvc.rotateInvitationToken).toHaveBeenCalled();
  });
});

describe('TenantUserLifecycleService.editInvitedUserEmail (§4.4 — FAILED-only)', () => {
  // S3 ships NO FAILED writer, so EVERY current status rejects. The guard is
  // live now; the mutate path is built + ready for S4.
  for (const status of [
    { is_active: true, invite_status: 'INVITED', displayed: 'INVITED' },
    { is_active: true, invite_status: 'ACCEPTED', displayed: 'ACCEPTED' },
    { is_active: true, invite_status: 'ACTIVE', displayed: 'ACTIVE' },
    { is_active: false, invite_status: 'ACTIVE', displayed: 'INACTIVE' },
  ]) {
    it(`${status.displayed} → 4xx email_locked; no email mutation`, async () => {
      const { service, identitySvc } = makeMocks();
      identitySvc.findMembership.mockResolvedValue(
        membership({
          is_active: status.is_active,
          invite_status: status.invite_status,
        }),
      );
      await expect(
        service.editInvitedUserEmail({
          tenant_id: TENANT_ID,
          user_id: USER_ID,
          new_email: 'fixed@aramo.dev',
          request_id: REQUEST_ID,
        }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        context: { details: { reason: 'email_locked' } },
      });
      expect(identitySvc.updateUserEmail).not.toHaveBeenCalled();
    });
  }

  it('FAILED → mutates email + rotates token + sends invitation (the S4-ready happy path)', async () => {
    const { service, identitySvc, mailer } = makeMocks();
    identitySvc.findMembership.mockResolvedValue(
      membership({ is_active: true, invite_status: 'FAILED' }),
    );
    identitySvc.findActiveInvitation.mockResolvedValue(INVITATION);
    identitySvc.findUserById.mockResolvedValue(makeUserDto());
    const result = await service.editInvitedUserEmail({
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      new_email: 'fixed@aramo.dev',
      request_id: REQUEST_ID,
    });
    expect(result).toEqual({ sent: 'invitation' });
    expect(identitySvc.updateUserEmail).toHaveBeenCalledWith({
      user_id: USER_ID,
      email: 'fixed@aramo.dev',
    });
    expect(identitySvc.rotateInvitationToken).toHaveBeenCalled();
    // Invitation email goes to the CORRECTED address.
    const sent = mailer.send.mock.calls[0]![0] as { to: string };
    expect(sent.to).toBe('fixed@aramo.dev');
  });

  it('FAILED + email collision (P2002) → 4xx email_in_use; no token rotate', async () => {
    const { service, identitySvc } = makeMocks();
    identitySvc.findMembership.mockResolvedValue(
      membership({ is_active: true, invite_status: 'FAILED' }),
    );
    identitySvc.updateUserEmail.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    await expect(
      service.editInvitedUserEmail({
        tenant_id: TENANT_ID,
        user_id: USER_ID,
        new_email: 'taken@aramo.dev',
        request_id: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      context: { details: { reason: 'email_in_use' } },
    });
    expect(identitySvc.rotateInvitationToken).not.toHaveBeenCalled();
  });
});
