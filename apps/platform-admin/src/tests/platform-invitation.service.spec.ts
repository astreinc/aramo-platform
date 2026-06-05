import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';

import { PlatformInvitationService } from '../app/platform/platform-invitation.service.js';
import type { CognitoAdminService } from '../app/platform/cognito/cognito-admin.service.js';

// Unit-level proofs for the platform-tier saga. The integration spec
// (platform.integration.spec.ts) exercises the same paths against real
// Postgres + a mocked Cognito client; here the persistence layer is
// mocked too so the test asserts the orchestration: which service is
// called when, in what order, with what arguments.

interface Mocks {
  cognito: {
    adminCreateUser: ReturnType<typeof vi.fn>;
    adminGetUser: ReturnType<typeof vi.fn>;
    adminDeleteUser: ReturnType<typeof vi.fn>;
  };
  tenantSvc: {
    findByNameCaseInsensitive: ReturnType<typeof vi.fn>;
    provisionTenant: ReturnType<typeof vi.fn>;
    deactivateTenant: ReturnType<typeof vi.fn>;
  };
  identitySvc: {
    resolveRoleIdsByKeys: ReturnType<typeof vi.fn>;
    createUserFromInvitation: ReturnType<typeof vi.fn>;
    findUserByEmail: ReturnType<typeof vi.fn>;
    findMembership: ReturnType<typeof vi.fn>;
    findRoleIdsForMembership: ReturnType<typeof vi.fn>;
    addMembershipForExistingUser: ReturnType<typeof vi.fn>;
    replaceMembershipRoles: ReturnType<typeof vi.fn>;
  };
  entitlementRepo: {
    grantCapabilities: ReturnType<typeof vi.fn>;
  };
}

function makeMocks(): Mocks {
  return {
    cognito: {
      adminCreateUser: vi.fn(),
      adminGetUser: vi.fn(),
      adminDeleteUser: vi.fn(),
    },
    tenantSvc: {
      findByNameCaseInsensitive: vi.fn(),
      provisionTenant: vi.fn(),
      deactivateTenant: vi.fn(),
    },
    identitySvc: {
      resolveRoleIdsByKeys: vi.fn(),
      createUserFromInvitation: vi.fn(),
      findUserByEmail: vi.fn(),
      findMembership: vi.fn(),
      findRoleIdsForMembership: vi.fn(),
      addMembershipForExistingUser: vi.fn(),
      replaceMembershipRoles: vi.fn(),
    },
    entitlementRepo: {
      grantCapabilities: vi.fn(),
    },
  };
}

function buildService(mocks: Mocks): PlatformInvitationService {
  return new PlatformInvitationService(
    mocks.cognito as unknown as CognitoAdminService,
    mocks.tenantSvc as never,
    mocks.identitySvc as never,
    mocks.entitlementRepo as never,
  );
}

describe('PlatformInvitationService — provisionTenantAndInviteOwner (proof 2 + 3 + 4 unit)', () => {
  it('happy path: Cognito-first AdminCreateUser -> identity-tx -> entitlement-tx; Tenant Owner role assigned', async () => {
    const mocks = makeMocks();
    mocks.tenantSvc.findByNameCaseInsensitive.mockResolvedValue(null);
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['role-id-tenant-owner']);
    mocks.cognito.adminCreateUser.mockResolvedValue({ cognito_sub: 'cog-sub-123' });
    mocks.tenantSvc.provisionTenant.mockResolvedValue({
      id: 'tenant-x',
      name: 'AcmeCo',
      is_active: true,
      created_at: '',
      updated_at: '',
    });
    mocks.identitySvc.createUserFromInvitation.mockResolvedValue({
      user: { id: 'owner-u', email: 'owner@acme.io', display_name: 'Acme Owner', is_active: true, deactivated_at: null, created_at: '', updated_at: '' },
      membership_id: 'mem-1',
    });
    mocks.entitlementRepo.grantCapabilities.mockResolvedValue(undefined);

    const svc = buildService(mocks);
    const out = await svc.provisionTenantAndInviteOwner({
      name: 'AcmeCo',
      owner_email: 'owner@acme.io',
      owner_display_name: 'Acme Owner',
      actor_user_id: 'super-admin-1',
    });

    // Pattern A: Cognito is called BEFORE identity-tx.
    expect(mocks.cognito.adminCreateUser).toHaveBeenCalledWith({
      pool: 'tenant',
      email: 'owner@acme.io',
      display_name: 'Acme Owner',
    });
    expect(mocks.tenantSvc.provisionTenant).toHaveBeenCalled();
    expect(mocks.identitySvc.createUserFromInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'owner@acme.io',
        provider: 'cognito',
        provider_subject: 'cog-sub-123',
        tenant_id: 'tenant-x',
        role_ids: ['role-id-tenant-owner'],
      }),
    );
    expect(mocks.entitlementRepo.grantCapabilities).toHaveBeenCalledWith({
      tenant_id: 'tenant-x',
      capabilities: ['core', 'ats', 'portal'],
    });
    // Compensation paths NOT invoked.
    expect(mocks.cognito.adminDeleteUser).not.toHaveBeenCalled();
    expect(mocks.tenantSvc.deactivateTenant).not.toHaveBeenCalled();
    // The Tenant-Owner-first invariant.
    expect(mocks.identitySvc.resolveRoleIdsByKeys).toHaveBeenCalledWith([
      'tenant_owner',
    ]);

    expect(out).toMatchObject({
      tenant_id: 'tenant-x',
      tenant_name: 'AcmeCo',
      owner_user_id: 'owner-u',
      owner_email: 'owner@acme.io',
      membership_id: 'mem-1',
      capabilities: ['core', 'ats', 'portal'],
    });
  });

  it('name collision: TENANT_ALREADY_EXISTS raised BEFORE Cognito (no AdminCreateUser side effect)', async () => {
    const mocks = makeMocks();
    mocks.tenantSvc.findByNameCaseInsensitive.mockResolvedValue({
      id: 'existing-id',
      name: 'AcmeCo',
      is_active: true,
      created_at: '',
      updated_at: '',
    });

    const svc = buildService(mocks);
    await expect(
      svc.provisionTenantAndInviteOwner({
        name: 'AcmeCo',
        owner_email: 'owner@acme.io',
        actor_user_id: 'a',
      }),
    ).rejects.toMatchObject({ code: 'TENANT_ALREADY_EXISTS', statusCode: 409 });

    expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
    expect(mocks.tenantSvc.provisionTenant).not.toHaveBeenCalled();
  });

  it('identity-tx failure -> Cognito compensated via AdminDeleteUser (Lead ruling 7)', async () => {
    const mocks = makeMocks();
    mocks.tenantSvc.findByNameCaseInsensitive.mockResolvedValue(null);
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r1']);
    mocks.cognito.adminCreateUser.mockResolvedValue({ cognito_sub: 'cog-1' });
    mocks.tenantSvc.provisionTenant.mockRejectedValue(new Error('db down'));

    const svc = buildService(mocks);
    await expect(
      svc.provisionTenantAndInviteOwner({
        name: 'NewCo',
        owner_email: 'o@new.co',
        actor_user_id: 'a',
      }),
    ).rejects.toThrow('db down');

    expect(mocks.cognito.adminDeleteUser).toHaveBeenCalledWith({
      pool: 'tenant',
      email: 'o@new.co',
    });
  });

  it('entitlement-tx failure -> tenant SOFT-DISABLED (is_active=false); identity/Cognito records preserved (Lead ruling 7)', async () => {
    const mocks = makeMocks();
    mocks.tenantSvc.findByNameCaseInsensitive.mockResolvedValue(null);
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r1']);
    mocks.cognito.adminCreateUser.mockResolvedValue({ cognito_sub: 'cog-1' });
    mocks.tenantSvc.provisionTenant.mockResolvedValue({
      id: 'tenant-y',
      name: 'NewCo',
      is_active: true,
      created_at: '',
      updated_at: '',
    });
    mocks.identitySvc.createUserFromInvitation.mockResolvedValue({
      user: { id: 'u1', email: 'o@new.co', display_name: null, is_active: true, deactivated_at: null, created_at: '', updated_at: '' },
      membership_id: 'm1',
    });
    mocks.entitlementRepo.grantCapabilities.mockRejectedValue(new Error('entitlement schema down'));
    mocks.tenantSvc.deactivateTenant.mockResolvedValue(undefined);

    const svc = buildService(mocks);
    await expect(
      svc.provisionTenantAndInviteOwner({
        name: 'NewCo',
        owner_email: 'o@new.co',
        actor_user_id: 'a',
      }),
    ).rejects.toBeInstanceOf(AramoError);

    expect(mocks.tenantSvc.deactivateTenant).toHaveBeenCalledWith({
      tenant_id: 'tenant-y',
      actor_user_id: 'a',
      reason: 'entitlement_grant_failed',
    });
    // No Cognito rollback (Lead ruling 7 — Cognito + identity stay durable;
    // the tenant becomes inert via is_active=false).
    expect(mocks.cognito.adminDeleteUser).not.toHaveBeenCalled();
  });

  it('Cognito AdminCreateUser failure -> COGNITO_PROVISION_FAILED 502 (no identity-tx attempted)', async () => {
    const mocks = makeMocks();
    mocks.tenantSvc.findByNameCaseInsensitive.mockResolvedValue(null);
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r1']);
    mocks.cognito.adminCreateUser.mockRejectedValue(new Error('Cognito unavailable'));

    const svc = buildService(mocks);
    await expect(
      svc.provisionTenantAndInviteOwner({
        name: 'NewCo',
        owner_email: 'o@new.co',
        actor_user_id: 'a',
      }),
    ).rejects.toMatchObject({
      code: 'COGNITO_PROVISION_FAILED',
      statusCode: 502,
    });

    expect(mocks.tenantSvc.provisionTenant).not.toHaveBeenCalled();
    expect(mocks.identitySvc.createUserFromInvitation).not.toHaveBeenCalled();
  });

  it('multi-role invite (proof 5): role_keys plural -> multiple UserTenantMembershipRole writes', async () => {
    // AUTHZ-1b fixture swap: hiring_manager retired -> use account_manager
    // (a kept staffing role) as the second role_keys entry.
    const mocks = makeMocks();
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r-rec', 'r-am']);
    mocks.cognito.adminGetUser.mockResolvedValue(null);
    mocks.identitySvc.findUserByEmail.mockResolvedValue(null);
    mocks.cognito.adminCreateUser.mockResolvedValue({ cognito_sub: 'cog-x' });
    mocks.identitySvc.createUserFromInvitation.mockResolvedValue({
      user: { id: 'u-new', email: 'r@t.io', display_name: null, is_active: true, deactivated_at: null, created_at: '', updated_at: '' },
      membership_id: 'm-new',
    });

    const svc = buildService(mocks);
    const out = await svc.inviteUserIntoTenant({
      tenant_id: 't1',
      email: 'r@t.io',
      role_keys: ['recruiter', 'account_manager'],
      actor_user_id: 'sa',
      pool: 'tenant',
    });

    expect(mocks.identitySvc.createUserFromInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        role_ids: ['r-rec', 'r-am'],
      }),
    );
    expect(out.status).toBe('invitation_sent');
    expect(out.role_keys).toEqual(['recruiter', 'account_manager']);
  });
});

describe('PlatformInvitationService — inviteUserIntoTenant idempotency (proof 6, the 4 cases — Lead ruling 8)', () => {
  it('case 1: same email + same tenant + same roles -> 409 INVITATION_ALREADY_EXISTS', async () => {
    const mocks = makeMocks();
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r-rec']);
    mocks.cognito.adminGetUser.mockResolvedValue({ cognito_sub: 'sub-1' });
    mocks.identitySvc.findUserByEmail.mockResolvedValue({
      id: 'u-1', email: 'u@t.io', display_name: null, is_active: true, deactivated_at: null, created_at: '', updated_at: '',
    });
    mocks.identitySvc.findMembership.mockResolvedValue({
      id: 'mem-1', user_id: 'u-1', tenant_id: 't1', site_id: null, is_active: true, joined_at: '', deactivated_at: null, created_at: '', updated_at: '',
    });
    mocks.identitySvc.findRoleIdsForMembership.mockResolvedValue(['r-rec']);

    const svc = buildService(mocks);
    await expect(
      svc.inviteUserIntoTenant({
        tenant_id: 't1',
        email: 'u@t.io',
        role_keys: ['recruiter'],
        actor_user_id: 'sa',
        pool: 'tenant',
      }),
    ).rejects.toMatchObject({
      code: 'INVITATION_ALREADY_EXISTS',
      statusCode: 409,
    });
    expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
  });

  it('case 2: same tenant + DIFFERENT roles -> reconcile (replaceMembershipRoles)', async () => {
    // AUTHZ-1b fixture swap: hiring_manager retired -> account_manager.
    const mocks = makeMocks();
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r-rec', 'r-am']);
    mocks.cognito.adminGetUser.mockResolvedValue({ cognito_sub: 'sub-1' });
    mocks.identitySvc.findUserByEmail.mockResolvedValue({
      id: 'u-1', email: 'u@t.io', display_name: null, is_active: true, deactivated_at: null, created_at: '', updated_at: '',
    });
    mocks.identitySvc.findMembership.mockResolvedValue({
      id: 'mem-1', user_id: 'u-1', tenant_id: 't1', site_id: null, is_active: true, joined_at: '', deactivated_at: null, created_at: '', updated_at: '',
    });
    mocks.identitySvc.findRoleIdsForMembership.mockResolvedValue(['r-rec']);
    mocks.identitySvc.replaceMembershipRoles.mockResolvedValue({
      added_role_ids: ['r-am'],
      removed_role_ids: [],
    });

    const svc = buildService(mocks);
    const out = await svc.inviteUserIntoTenant({
      tenant_id: 't1',
      email: 'u@t.io',
      role_keys: ['recruiter', 'account_manager'],
      actor_user_id: 'sa',
      pool: 'tenant',
    });
    expect(out.status).toBe('roles_updated');
    expect(mocks.identitySvc.replaceMembershipRoles).toHaveBeenCalledWith({
      membership_id: 'mem-1',
      role_ids: ['r-rec', 'r-am'],
    });
  });

  it('case 3: new tenant for existing user -> addMembershipForExistingUser, NO Cognito re-create', async () => {
    const mocks = makeMocks();
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r-rec']);
    mocks.cognito.adminGetUser.mockResolvedValue({ cognito_sub: 'sub-1' });
    mocks.identitySvc.findUserByEmail.mockResolvedValue({
      id: 'u-1', email: 'u@t.io', display_name: null, is_active: true, deactivated_at: null, created_at: '', updated_at: '',
    });
    mocks.identitySvc.findMembership.mockResolvedValue(null);
    mocks.identitySvc.addMembershipForExistingUser.mockResolvedValue({
      membership_id: 'mem-new',
      membership_role_ids: ['mr-1'],
    });

    const svc = buildService(mocks);
    const out = await svc.inviteUserIntoTenant({
      tenant_id: 't-new',
      email: 'u@t.io',
      role_keys: ['recruiter'],
      actor_user_id: 'sa',
      pool: 'tenant',
    });
    expect(out.status).toBe('membership_added');
    expect(out.membership_id).toBe('mem-new');
    expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
  });

  it('case 4: drift (Cognito has user, identity does not) -> mirror identity from existing Cognito sub', async () => {
    const mocks = makeMocks();
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r-rec']);
    mocks.cognito.adminGetUser.mockResolvedValue({ cognito_sub: 'drift-sub' });
    mocks.identitySvc.findUserByEmail.mockResolvedValue(null);
    mocks.identitySvc.createUserFromInvitation.mockResolvedValue({
      user: { id: 'u-drift', email: 'd@t.io', display_name: null, is_active: true, deactivated_at: null, created_at: '', updated_at: '' },
      membership_id: 'mem-drift',
    });

    const svc = buildService(mocks);
    const out = await svc.inviteUserIntoTenant({
      tenant_id: 't1',
      email: 'd@t.io',
      role_keys: ['recruiter'],
      actor_user_id: 'sa',
      pool: 'tenant',
    });
    expect(out.status).toBe('invitation_sent');
    // The existing Cognito sub is reused (no AdminCreateUser).
    expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
    expect(mocks.identitySvc.createUserFromInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'cognito',
        provider_subject: 'drift-sub',
      }),
    );
  });
});

describe('PlatformInvitationService — platform admin invite (proof 7 platform-namespace check)', () => {
  it('uses PLATFORM pool and super_admin role; tenant_id = sentinel', async () => {
    const mocks = makeMocks();
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r-super']);
    mocks.cognito.adminGetUser.mockResolvedValue(null);
    mocks.identitySvc.findUserByEmail.mockResolvedValue(null);
    mocks.cognito.adminCreateUser.mockResolvedValue({ cognito_sub: 'plat-sub' });
    mocks.identitySvc.createUserFromInvitation.mockResolvedValue({
      user: { id: 'plat-u', email: 'p@a.io', display_name: null, is_active: true, deactivated_at: null, created_at: '', updated_at: '' },
      membership_id: 'plat-m',
    });

    const svc = buildService(mocks);
    await svc.invitePlatformAdmin({
      email: 'p@a.io',
      actor_user_id: 'sa',
    });

    expect(mocks.identitySvc.resolveRoleIdsByKeys).toHaveBeenCalledWith([
      'super_admin',
    ]);
    expect(mocks.cognito.adminCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({ pool: 'platform', email: 'p@a.io' }),
    );
    // Sentinel tenant id is the PLATFORM_TENANT_SENTINEL_ID from libs/auth.
    expect(mocks.identitySvc.createUserFromInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: '01900000-0000-7000-8000-000000000100',
      }),
    );
  });
});
