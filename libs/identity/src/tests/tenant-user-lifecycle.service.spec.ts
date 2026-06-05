import { describe, expect, it, vi } from 'vitest';

import type { UserDto } from '../lib/dto/user.dto.js';
import type { IdentityService } from '../lib/identity.service.js';
import type { RoleBundleValidator } from '../lib/tenant-user/role-bundle-validator.js';
import type { TenantCognitoPort } from '../lib/tenant-user/tenant-cognito.port.js';
import { TenantUserLifecycleService } from '../lib/tenant-user/tenant-user-lifecycle.service.js';

// Settings S3a — TenantUserLifecycleService saga proofs.
//
// The cross-store saga + compensation + D5 validator integration. Mocks
// IdentityService + RoleBundleValidator + TenantCognitoPort; asserts:
//   INVITE:
//     - empty role_keys → 400 VALIDATION_ERROR (no Cognito call)
//     - invertible union → 400 VALIDATION_ERROR (no Cognito call —
//       validator fires BEFORE the side effect)
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
    createUserFromInvitation: ReturnType<typeof vi.fn>;
    findUserById: ReturnType<typeof vi.fn>;
    disableMembership: ReturnType<typeof vi.fn>;
    reEnableMembership: ReturnType<typeof vi.fn>;
  };
  roleBundle: {
    assertUnionNonInvertible: ReturnType<typeof vi.fn>;
  };
  cognito: {
    adminCreateUser: ReturnType<typeof vi.fn>;
    adminDeleteUser: ReturnType<typeof vi.fn>;
    adminDisableUser: ReturnType<typeof vi.fn>;
    adminEnableUser: ReturnType<typeof vi.fn>;
  };
  service: TenantUserLifecycleService;
}

function makeMocks(): Mocks {
  const identitySvc = {
    resolveRoleIdsByKeys: vi.fn(),
    createUserFromInvitation: vi.fn(),
    findUserById: vi.fn(),
    disableMembership: vi.fn(),
    reEnableMembership: vi.fn(),
  };
  const roleBundle = {
    assertUnionNonInvertible: vi.fn().mockResolvedValue(undefined),
  };
  const cognito = {
    adminCreateUser: vi.fn(),
    adminDeleteUser: vi.fn().mockResolvedValue(undefined),
    adminDisableUser: vi.fn(),
    adminEnableUser: vi.fn(),
  };
  const service = new TenantUserLifecycleService(
    identitySvc as unknown as IdentityService,
    roleBundle as unknown as RoleBundleValidator,
    cognito as unknown as TenantCognitoPort,
  );
  return { identitySvc, roleBundle, cognito, service };
}

describe('TenantUserLifecycleService.inviteTenantUser', () => {
  it('empty role_keys → VALIDATION_ERROR (no Cognito call)', async () => {
    const { service, cognito, roleBundle } = makeMocks();
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
    expect(cognito.adminCreateUser).not.toHaveBeenCalled();
    expect(roleBundle.assertUnionNonInvertible).not.toHaveBeenCalled();
  });

  it('invertible role union → VALIDATION_ERROR (validator fires BEFORE Cognito)', async () => {
    const { service, cognito, identitySvc, roleBundle } = makeMocks();
    identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['rid-1', 'rid-2']);
    roleBundle.assertUnionNonInvertible.mockRejectedValue(
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
    expect(cognito.adminCreateUser).not.toHaveBeenCalled();
    expect(identitySvc.createUserFromInvitation).not.toHaveBeenCalled();
  });

  it('Cognito AdminCreateUser failure → 502 COGNITO_PROVISION_FAILED; no identity-tx, no rollback', async () => {
    const { service, cognito, identitySvc } = makeMocks();
    identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['rid-1']);
    cognito.adminCreateUser.mockRejectedValue(new Error('cognito boom'));
    await expect(
      service.inviteTenantUser({
        tenant_id: TENANT_ID,
        email: EMAIL,
        display_name: null,
        role_keys: ['rA'],
        actor_user_id: ACTOR_ID,
        request_id: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: 'COGNITO_PROVISION_FAILED',
      statusCode: 502,
    });
    expect(identitySvc.createUserFromInvitation).not.toHaveBeenCalled();
    expect(cognito.adminDeleteUser).not.toHaveBeenCalled();
  });

  it('identity-tx failure post-Cognito → rethrows + Cognito rollback (AdminDeleteUser called)', async () => {
    const { service, cognito, identitySvc } = makeMocks();
    identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['rid-1']);
    cognito.adminCreateUser.mockResolvedValue({ cognito_sub: 'cog-sub-x' });
    identitySvc.createUserFromInvitation.mockRejectedValue(
      new Error('identity tx boom'),
    );
    await expect(
      service.inviteTenantUser({
        tenant_id: TENANT_ID,
        email: EMAIL,
        display_name: null,
        role_keys: ['rA'],
        actor_user_id: ACTOR_ID,
        request_id: REQUEST_ID,
      }),
    ).rejects.toThrow('identity tx boom');
    expect(cognito.adminDeleteUser).toHaveBeenCalledWith({ email: EMAIL });
  });

  it('happy path → returns user + membership_id + cognito_sub; identity called with caller tenant_id', async () => {
    const { service, cognito, identitySvc } = makeMocks();
    identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['rid-1', 'rid-2']);
    cognito.adminCreateUser.mockResolvedValue({ cognito_sub: 'cog-sub-1' });
    identitySvc.createUserFromInvitation.mockResolvedValue({
      user: makeUserDto(),
      membership_id: 'mem-1',
    });
    const result = await service.inviteTenantUser({
      tenant_id: TENANT_ID,
      email: EMAIL,
      display_name: 'Invitee Person',
      role_keys: ['rA', 'rB'],
      actor_user_id: ACTOR_ID,
      request_id: REQUEST_ID,
    });
    expect(result).toEqual({
      user: makeUserDto(),
      membership_id: 'mem-1',
      cognito_sub: 'cog-sub-1',
    });
    expect(identitySvc.createUserFromInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TENANT_ID,
        actor_user_id: ACTOR_ID,
        provider: 'cognito',
        provider_subject: 'cog-sub-1',
        role_ids: ['rid-1', 'rid-2'],
      }),
    );
    expect(cognito.adminDeleteUser).not.toHaveBeenCalled();
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
