import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';

import {
  PlatformInvitationService,
  platformAdminEmailDomains,
} from '../app/platform/platform-invitation.service.js';
import type { CognitoAdminService } from '../app/platform/cognito/cognito-admin.service.js';

// Unit-level proofs for the platform-tier saga. The integration spec
// (platform.integration.spec.ts) exercises the same paths against real
// Postgres + a mocked Cognito client; here the persistence layer is
// mocked too so the test asserts the orchestration: which service is
// called when, in what order, with what arguments.
//
// D-AUTHZ-PLATFORM-INVITE-1 (Gate-6 update): the platform invite methods
// now take a `request_id` arg (threaded from PlatformController via
// @RequestId) and the IdentityService write calls now also carry
// `role_keys` + `request_id` so the in-service D5 union-non-invertibility
// check has its inputs. The exploit-rejected proof + the safe-by-
// construction proofs live in the integration spec + identity.service
// .spec.ts respectively; this file verifies the orchestration threading.

const TEST_REQUEST_ID = 'rq-plat-001';

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
    recordOwnerInviteSent: ReturnType<typeof vi.fn>;
    hasOwnerInviteBeenSent: ReturnType<typeof vi.fn>;
  };
  identitySvc: {
    resolveRoleIdsByKeys: ReturnType<typeof vi.fn>;
    createUserFromInvitation: ReturnType<typeof vi.fn>;
    findUserByEmail: ReturnType<typeof vi.fn>;
    findRoleIdsForMembership: ReturnType<typeof vi.fn>;
    // IC-1 PR-1 — the ownership classification + governed cross-tenant
    // refusal (addMembershipForExistingUser is RETIRED and absent here).
    classifyInviteEmailOwnership: ReturnType<typeof vi.fn>;
    rejectCrossTenantInvitation: ReturnType<typeof vi.fn>;
    replaceMembershipRoles: ReturnType<typeof vi.fn>;
  };
  entitlementRepo: {
    grantCapabilities: ReturnType<typeof vi.fn>;
  };
  // ADR-0024 PR-4a-2 — step 4 (the requisition-lifecycle template copy).
  policyProvisioning: {
    publishDefaultLifecyclePackage: ReturnType<typeof vi.fn>;
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
      recordOwnerInviteSent: vi.fn(),
      hasOwnerInviteBeenSent: vi.fn(),
    },
    identitySvc: {
      resolveRoleIdsByKeys: vi.fn(),
      createUserFromInvitation: vi.fn(),
      // IC-1 PR-1: the provision 0a-ter pre-check reads this; default = no
      // existing user (the pre-IC-1 provisioning tests are unaffected).
      findUserByEmail: vi.fn().mockResolvedValue(null),
      findRoleIdsForMembership: vi.fn(),
      // IC-1 PR-1: default = unregistered (greenfield / drift paths proceed);
      // the refusal mock throws the SAME governed error the real service does.
      classifyInviteEmailOwnership: vi
        .fn()
        .mockResolvedValue({ kind: 'unregistered' }),
      rejectCrossTenantInvitation: vi.fn().mockImplementation(async () => {
        throw new AramoError(
          'EMAIL_UNAVAILABLE',
          'This email address is not available for invitation',
          409,
          { requestId: TEST_REQUEST_ID, details: {} },
        );
      }),
      replaceMembershipRoles: vi.fn(),
    },
    entitlementRepo: {
      grantCapabilities: vi.fn(),
    },
    policyProvisioning: {
      publishDefaultLifecyclePackage: vi.fn(),
    },
    // Domain-Enforcement P3 — default: the domain is free.
    domainClaims: {
      isDomainHeld: vi.fn().mockResolvedValue(false),
      lapse: vi.fn().mockResolvedValue(undefined),
    },
    // CCP-A9 — default inviter: an attested platform_owner; the human reference is free.
    operators: {
      readOperatorNow: vi.fn().mockResolvedValue({ user_id: 'sa', attested: true, attestation_id: 'att-sa', role_keys: ['platform_owner', 'super_admin'], scopes: [] }),
      isHumanRefActive: vi.fn().mockResolvedValue(false),
      recordAttestation: vi.fn().mockResolvedValue({ id: 'att-new' }),
    },
  };
}

function buildService(mocks: Mocks): PlatformInvitationService {
  return new PlatformInvitationService(
    mocks.cognito as unknown as CognitoAdminService,
    mocks.tenantSvc as never,
    mocks.identitySvc as never,
    mocks.entitlementRepo as never,
    mocks.policyProvisioning as never,
    mocks.domainClaims as never,
    mocks.operators as never,
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
      request_id: TEST_REQUEST_ID,
      invite_owner: true,
    });

    // Pattern A: Cognito is called BEFORE identity-tx. invite_owner=true → the
    // invitation email is sent at creation (suppress:false — byte-equivalent to
    // the pre-3.4 default path).
    expect(mocks.cognito.adminCreateUser).toHaveBeenCalledWith({
      pool: 'tenant',
      email: 'owner@acme.io',
      display_name: 'Acme Owner',
      suppress: false,
    });
    // B2 — the provision event records invitation_sent:true.
    expect(mocks.tenantSvc.provisionTenant).toHaveBeenCalledWith(
      expect.objectContaining({ invitation_sent: true }),
    );
    // B2 — mail went, so tenant.owner_invite.sent(first_send) is emitted.
    expect(mocks.tenantSvc.recordOwnerInviteSent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'first_send', tenant_id: 'tenant-x' }),
    );
    // D-AUTHZ-PLATFORM-INVITE-1: role_keys + request_id threaded so the
    // in-service D5 union check has its inputs. tenant_owner is a see-
    // all-tier role (validator's see-all bypass).
    expect(mocks.identitySvc.createUserFromInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'owner@acme.io',
        provider: 'cognito',
        provider_subject: 'cog-sub-123',
        tenant_id: 'tenant-x',
        // ROLES-1 PR-2 (§6) — every new tenant's first owner: tenant_owner + tenant_admin.
        role_keys: ['tenant_owner', 'tenant_admin'],
        role_ids: ['role-id-tenant-owner'],
        request_id: TEST_REQUEST_ID,
      }),
    );
    expect(mocks.entitlementRepo.grantCapabilities).toHaveBeenCalledWith({
      tenant_id: 'tenant-x',
      capabilities: ['core', 'ats', 'portal'],
      // CCP-A7 (D4) — non-commercial provisioning provenance.
      granted_source: 'PROVISIONING',
      granted_by: 'super-admin-1',
    });
    // ADR-0024 PR-4a-2 (step 4) — the new tenant's requisition-lifecycle package
    // is published (template copy) as part of provisioning.
    expect(
      mocks.policyProvisioning.publishDefaultLifecyclePackage,
    ).toHaveBeenCalledWith('tenant-x');
    // Compensation paths NOT invoked.
    expect(mocks.cognito.adminDeleteUser).not.toHaveBeenCalled();
    expect(mocks.tenantSvc.deactivateTenant).not.toHaveBeenCalled();
    // The Tenant-Owner-first invariant.
    expect(mocks.identitySvc.resolveRoleIdsByKeys).toHaveBeenCalledWith([
      'tenant_owner',
      'tenant_admin',
    ]);

    expect(out).toMatchObject({
      tenant_id: 'tenant-x',
      tenant_name: 'AcmeCo',
      owner_user_id: 'owner-u',
      owner_email: 'owner@acme.io',
      membership_id: 'mem-1',
      capabilities: ['core', 'ats', 'portal'],
      invitation_sent: true,
    });
  });

  // IC-2 PR-4 (F-4) — the optional slug is forwarded VERBATIM to
  // TenantService.provisionTenant (deriveSlugOrThrow validates it there) and is
  // ABSENT from the call when omitted (slug NULL, the pre-PR-4 shape). Never
  // derived from the name.
  it('IC-2 PR-4 (F-4): slug supplied → forwarded verbatim; omitted → not passed (never derived)', async () => {
    const run = async (slug: string | undefined) => {
      const mocks = makeMocks();
      mocks.tenantSvc.findByNameCaseInsensitive.mockResolvedValue(null);
      mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['role-id-tenant-owner']);
      mocks.cognito.adminCreateUser.mockResolvedValue({ cognito_sub: 'cog-sub-123' });
      mocks.tenantSvc.provisionTenant.mockResolvedValue({ id: 'tenant-x', name: 'AcmeCo', is_active: true, created_at: '', updated_at: '' });
      mocks.identitySvc.createUserFromInvitation.mockResolvedValue({
        user: { id: 'owner-u', email: 'owner@acme.io', display_name: null, is_active: true, deactivated_at: null, created_at: '', updated_at: '' },
        membership_id: 'mem-1',
      });
      mocks.entitlementRepo.grantCapabilities.mockResolvedValue(undefined);
      await buildService(mocks).provisionTenantAndInviteOwner({
        name: 'AcmeCo',
        owner_email: 'owner@acme.io',
        actor_user_id: 'super-admin-1',
        request_id: TEST_REQUEST_ID,
        invite_owner: true,
        ...(slug === undefined ? {} : { slug }),
      });
      return mocks.tenantSvc.provisionTenant.mock.calls[0]![0] as Record<string, unknown>;
    };
    const withSlug = await run('Acme-Co');
    expect(withSlug['slug']).toBe('Acme-Co'); // verbatim — normalization lives in deriveSlugOrThrow
    const without = await run(undefined);
    expect('slug' in without).toBe(false);
  });

  it('IC-2 PR-4 (F-4): a reserved / malformed slug is refused 400 BEFORE Cognito (no AdminCreateUser, no provisionTenant)', async () => {
    for (const [slug, reason] of [['admin', 'reserved_slug'], ['Bad Slug!', 'invalid_slug']] as const) {
      const mocks = makeMocks();
      mocks.tenantSvc.findByNameCaseInsensitive.mockResolvedValue(null);
      await expect(
        buildService(mocks).provisionTenantAndInviteOwner({
          name: 'AcmeCo',
          owner_email: 'owner@acme.io',
          actor_user_id: 'super-admin-1',
          request_id: TEST_REQUEST_ID,
          invite_owner: true,
          slug,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { reason } } });
      expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
      expect(mocks.tenantSvc.provisionTenant).not.toHaveBeenCalled();
    }
  });

  // IC-2 PR-5 — only the platform-admin invite (platform pool, sentinel tenant)
  // asserts the platform tier to the identity service; tenant-pool invites
  // never do, so super_admin is refused in-service for non-sentinel tenants.
  it('IC-2 PR-5: invitePlatformAdmin passes allow_platform_roles=true; a tenant-pool invite passes false', async () => {
    const mocks = makeMocks();
    mocks.cognito.adminGetUser = vi.fn().mockResolvedValue(null);
    mocks.identitySvc.findUserByEmail.mockResolvedValue(null);
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['role-id-super-admin']);
    mocks.cognito.adminCreateUser.mockResolvedValue({ cognito_sub: 'cog-sub-sa' });
    mocks.identitySvc.createUserFromInvitation.mockResolvedValue({
      user: { id: 'sa-u', email: 'sa@aramo.ai', display_name: null, is_active: true, deactivated_at: null, created_at: '', updated_at: '' },
      membership_id: 'mem-sa',
    });
    const svc = buildService(mocks);
    await svc.invitePlatformAdmin({ email: 'sa@aramo.ai', actor_user_id: 'super-admin-1', request_id: TEST_REQUEST_ID });
    expect(mocks.identitySvc.createUserFromInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ role_keys: ['super_admin'], allow_platform_roles: true }),
    );
    mocks.identitySvc.createUserFromInvitation.mockClear();
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['role-id-recruiter']);
    await svc.inviteUserIntoTenant({
      tenant_id: 'tenant-x',
      email: 'rec@acme.io',
      role_keys: ['recruiter'],
      display_name: null,
      actor_user_id: 'super-admin-1',
      pool: 'tenant',
      request_id: TEST_REQUEST_ID,
    });
    expect(mocks.identitySvc.createUserFromInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ role_keys: ['recruiter'], allow_platform_roles: false }),
    );
  });

  it('IC-2 PR-5: inviteUserIntoTenant (tenant pool) with super_admin → 400 platform_role_not_assignable BEFORE Cognito and before any identity call', async () => {
    const mocks = makeMocks();
    await expect(
      buildService(mocks).inviteUserIntoTenant({
        tenant_id: 'tenant-x',
        email: 'ops@acme.io',
        role_keys: ['recruiter', 'super_admin'],
        display_name: null,
        actor_user_id: 'super-admin-1',
        pool: 'tenant',
        request_id: TEST_REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { reason: 'platform_role_not_assignable', role_keys: ['super_admin'] } } });
    expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
    expect(mocks.cognito.adminGetUser).not.toHaveBeenCalled();
    expect(mocks.identitySvc.resolveRoleIdsByKeys).not.toHaveBeenCalled();
  });

  // CCP A1 §7.3(b) (Aramo-CCP-A1-Commercial-Roles-and-Scopes-Directive-v1_0) — each of the 6
  // platform-tier commercial roles is refused on an invite INTO a tenant (pool !== 'platform')
  // before any Cognito side effect and before any identity call. No service change: the
  // guard keys off PLATFORM_ROLE_KEYS.
  for (const key of ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor']) {
    it(`CCP A1 §7.3(b): inviteUserIntoTenant (tenant pool) with ${key} → 400 platform_role_not_assignable BEFORE Cognito`, async () => {
      const mocks = makeMocks();
      await expect(
        buildService(mocks).inviteUserIntoTenant({
          tenant_id: 'tenant-x',
          email: 'ops@acme.io',
          role_keys: ['recruiter', key],
          display_name: null,
          actor_user_id: 'super-admin-1',
          pool: 'tenant',
          request_id: TEST_REQUEST_ID,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400, context: { details: { reason: 'platform_role_not_assignable', role_keys: [key] } } });
      expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
      expect(mocks.cognito.adminGetUser).not.toHaveBeenCalled();
      expect(mocks.identitySvc.resolveRoleIdsByKeys).not.toHaveBeenCalled();
      expect(mocks.identitySvc.createUserFromInvitation).not.toHaveBeenCalled();
    });
  }

  // IC-3 PR-7 — product-neutral provisioning: owner role and ATS projections
  // follow the product set; core is always held; ATS-only is unchanged.
  describe('IC-3 PR-7 — product-neutral provisioning', () => {
    function armed() {
      const mocks = makeMocks();
      mocks.tenantSvc.findByNameCaseInsensitive.mockResolvedValue(null);
      mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['role-id']);
      mocks.cognito.adminCreateUser.mockResolvedValue({ cognito_sub: 'cog-sub-123' });
      mocks.tenantSvc.provisionTenant.mockResolvedValue({ id: 'tenant-x', name: 'X', is_active: true, created_at: '', updated_at: '' });
      mocks.identitySvc.createUserFromInvitation.mockResolvedValue({
        user: { id: 'owner-u', email: 'owner@acme.io', display_name: null, is_active: true, deactivated_at: null, created_at: '', updated_at: '' },
        membership_id: 'mem-1',
      });
      mocks.entitlementRepo.grantCapabilities.mockResolvedValue(undefined);
      return mocks;
    }
    const provision = (mocks: ReturnType<typeof makeMocks>, capabilities?: string[]) =>
      buildService(mocks).provisionTenantAndInviteOwner({
        name: 'X', owner_email: 'owner@acme.io', actor_user_id: 'super-admin-1', request_id: TEST_REQUEST_ID, invite_owner: true,
        ...(capabilities === undefined ? {} : { capabilities }),
      });

    // ROLES-1 PR-2 (§6) — the first owner of EVERY new tenant receives tenant_owner +
    // tenant_admin, whether or not the tenant is ATS-entitled (formerly org_admin without ats).
    it('Sign-only ([esign]): core is added, owner roles tenant_owner + tenant_admin, NO ATS projection (policy package / RTR template), entitlements [core, esign]', async () => {
      const mocks = armed();
      const out = await provision(mocks, ['sign']);
      expect(out.capabilities).toEqual(['core', 'sign']);
      expect(mocks.identitySvc.resolveRoleIdsByKeys).toHaveBeenCalledWith(['tenant_owner', 'tenant_admin']);
      expect(mocks.identitySvc.createUserFromInvitation).toHaveBeenCalledWith(
        expect.objectContaining({ role_keys: ['tenant_owner', 'tenant_admin'], owner_role_authority: 'platform' }),
      );
      expect(mocks.entitlementRepo.grantCapabilities).toHaveBeenCalledWith({ tenant_id: 'tenant-x', capabilities: ['core', 'sign'], granted_source: 'PROVISIONING', granted_by: 'super-admin-1' });
      expect(mocks.policyProvisioning.publishDefaultLifecyclePackage).not.toHaveBeenCalled();
      // exactly ONE tenant and ONE owner identity
      expect(mocks.tenantSvc.provisionTenant).toHaveBeenCalledTimes(1);
      expect(mocks.identitySvc.createUserFromInvitation).toHaveBeenCalledTimes(1);
    });

    it('ATS + Sign ([core, ats, portal, esign]): ONE tenant, ONE owner (tenant_owner + tenant_admin), both product entitlements, ATS projections run', async () => {
      const mocks = armed();
      const out = await provision(mocks, ['core', 'ats', 'portal', 'sign']);
      expect(out.capabilities).toEqual(['core', 'ats', 'portal', 'sign']);
      expect(mocks.identitySvc.resolveRoleIdsByKeys).toHaveBeenCalledWith(['tenant_owner', 'tenant_admin']);
      expect(mocks.policyProvisioning.publishDefaultLifecyclePackage).toHaveBeenCalledWith('tenant-x');
      expect(mocks.tenantSvc.provisionTenant).toHaveBeenCalledTimes(1);
    });

    it('ATS-only (default bundle, no capabilities supplied): tenant_owner + tenant_admin, {core, ats, portal}, projections run', async () => {
      const mocks = armed();
      const out = await provision(mocks);
      expect(out.capabilities).toEqual(['core', 'ats', 'portal']);
      expect(mocks.identitySvc.resolveRoleIdsByKeys).toHaveBeenCalledWith(['tenant_owner', 'tenant_admin']);
      expect(mocks.policyProvisioning.publishDefaultLifecyclePackage).toHaveBeenCalledTimes(1);
    });

    it('core alone ([core]): a valid organization with NO product — tenant_owner + tenant_admin owner, no projections, no product entitlement', async () => {
      const mocks = armed();
      const out = await provision(mocks, ['core']);
      expect(out.capabilities).toEqual(['core']);
      expect(mocks.identitySvc.resolveRoleIdsByKeys).toHaveBeenCalledWith(['tenant_owner', 'tenant_admin']);
      expect(mocks.policyProvisioning.publishDefaultLifecyclePackage).not.toHaveBeenCalled();
    });

    it('Sign-only entitlement-grant failure: tenant soft-disabled (no partial product access), 500 — same compensation as ATS', async () => {
      const mocks = armed();
      mocks.entitlementRepo.grantCapabilities.mockRejectedValue(new Error('entitlement schema down'));
      await expect(provision(mocks, ['sign'])).rejects.toMatchObject({ code: 'INTERNAL_ERROR', context: { details: { reason: 'entitlement_grant_failed' } } });
      expect(mocks.tenantSvc.deactivateTenant).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: 'tenant-x', reason: 'entitlement_grant_failed' }));
      expect(mocks.policyProvisioning.publishDefaultLifecyclePackage).not.toHaveBeenCalled();
    });
  });

  it('step 4 (ADR-0024 PR-4a-2): a policy-package publish failure soft-disables the tenant and throws INTERNAL_ERROR (created-and-flagged, not deleted)', async () => {
    const mocks = makeMocks();
    mocks.tenantSvc.findByNameCaseInsensitive.mockResolvedValue(null);
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['role-id-tenant-owner']);
    mocks.cognito.adminCreateUser.mockResolvedValue({ cognito_sub: 'cog-sub-9' });
    mocks.tenantSvc.provisionTenant.mockResolvedValue({
      id: 'tenant-y',
      name: 'BrokenCo',
      is_active: true,
      created_at: '',
      updated_at: '',
    });
    mocks.identitySvc.createUserFromInvitation.mockResolvedValue({
      user: { id: 'u', email: 'o@b.io', display_name: null, is_active: true, deactivated_at: null, created_at: '', updated_at: '' },
      membership_id: 'm',
    });
    mocks.entitlementRepo.grantCapabilities.mockResolvedValue(undefined);
    // Step 4 fails — e.g. no template published for the sentinel.
    mocks.policyProvisioning.publishDefaultLifecyclePackage.mockRejectedValue(
      new Error('policy_template_missing'),
    );

    const svc = buildService(mocks);
    await expect(
      svc.provisionTenantAndInviteOwner({
        name: 'BrokenCo',
        owner_email: 'o@b.io',
        actor_user_id: 'sa',
        request_id: TEST_REQUEST_ID,
        invite_owner: true,
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });

    // The tenant was CREATED (step 2) then SOFT-DISABLED (step 4 compensation) —
    // created-and-flagged (is_active=false), NOT deleted. The Cognito + identity
    // rows stay durable; the tenant is inert until a package is published.
    expect(mocks.tenantSvc.deactivateTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-y',
        reason: 'policy_package_publish_failed',
      }),
    );
    // The owner-invite emission never runs after a step-4 failure.
    expect(mocks.tenantSvc.recordOwnerInviteSent).not.toHaveBeenCalled();
  });

  it('DOC-TEMPLATE-LIB-1 T-3 (§5.3): an ATS tenant is provisioned with NO RTR template copy — no step 5, no RTR soft-disable path', async () => {
    const mocks = makeMocks();
    mocks.tenantSvc.findByNameCaseInsensitive.mockResolvedValue(null);
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['role-id-tenant-owner']);
    mocks.cognito.adminCreateUser.mockResolvedValue({ cognito_sub: 'cog-sub-10' });
    mocks.tenantSvc.provisionTenant.mockResolvedValue({
      id: 'tenant-z',
      name: 'RtrlessCo',
      is_active: true,
      created_at: '',
      updated_at: '',
    });
    mocks.identitySvc.createUserFromInvitation.mockResolvedValue({
      user: { id: 'u', email: 'o@b.io', display_name: null, is_active: true, deactivated_at: null, created_at: '', updated_at: '' },
      membership_id: 'm',
    });
    mocks.entitlementRepo.grantCapabilities.mockResolvedValue(undefined);
    // Step 4 (policy) succeeds. There is no step 5 any more: the RTR-TEMPLATE-1 copy of
    // the sentinel's RTR template is retired — the tenant resolves to the Aramo default.
    mocks.policyProvisioning.publishDefaultLifecyclePackage.mockResolvedValue(undefined);

    const svc = buildService(mocks);
    const out = await svc.provisionTenantAndInviteOwner({
      name: 'RtrlessCo',
      owner_email: 'o@b.io',
      actor_user_id: 'sa',
      request_id: TEST_REQUEST_ID,
      invite_owner: true,
    });

    expect(out.tenant_id).toBe('tenant-z');
    // The service has no documents dependency at all (constructor arity) and never
    // soft-disables for an RTR template reason.
    // Domain-Enforcement P3 adds the domain-claim dependency (5 → 6); still no documents dependency.
    // CCP-A9 adds the commercial operator repository (6 → 7).
    expect(PlatformInvitationService.length).toBe(7);
    expect(mocks.tenantSvc.deactivateTenant).not.toHaveBeenCalled();
    expect(mocks.policyProvisioning.publishDefaultLifecyclePackage).toHaveBeenCalledWith('tenant-z');
    expect(mocks.tenantSvc.recordOwnerInviteSent).toHaveBeenCalledTimes(1);
  });

  it('invite_owner=false (create-now-invite-later): Cognito SUPPRESSed, no owner_invite.sent, invitation_sent=false; tenant still provisioned', async () => {
    const mocks = makeMocks();
    mocks.tenantSvc.findByNameCaseInsensitive.mockResolvedValue(null);
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['role-id-tenant-owner']);
    mocks.cognito.adminCreateUser.mockResolvedValue({ cognito_sub: 'cog-sub-999' });
    mocks.tenantSvc.provisionTenant.mockResolvedValue({
      id: 'tenant-later',
      name: 'LaterCo',
      is_active: true,
      created_at: '',
      updated_at: '',
    });
    mocks.identitySvc.createUserFromInvitation.mockResolvedValue({
      user: { id: 'owner-later', email: 'owner@later.co', display_name: null, is_active: true, deactivated_at: null, created_at: '', updated_at: '' },
      membership_id: 'mem-later',
    });
    mocks.entitlementRepo.grantCapabilities.mockResolvedValue(undefined);

    const svc = buildService(mocks);
    const out = await svc.provisionTenantAndInviteOwner({
      name: 'LaterCo',
      owner_email: 'owner@later.co',
      actor_user_id: 'super-admin-1',
      request_id: TEST_REQUEST_ID,
      invite_owner: false,
    });

    // SUPPRESS: the Cognito user is created but NO invitation email is sent.
    expect(mocks.cognito.adminCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({ pool: 'tenant', email: 'owner@later.co', suppress: true }),
    );
    // Tenant still provisioned (identity-tx + entitlement-tx unchanged).
    expect(mocks.tenantSvc.provisionTenant).toHaveBeenCalledWith(
      expect.objectContaining({ invitation_sent: false }),
    );
    expect(mocks.entitlementRepo.grantCapabilities).toHaveBeenCalled();
    // B2 — no mail went, so NO tenant.owner_invite.sent is emitted at provision.
    expect(mocks.tenantSvc.recordOwnerInviteSent).not.toHaveBeenCalled();
    expect(out.invitation_sent).toBe(false);
  });

  it('IC-1 PR-1 0a-ter: owner email already registered to an existing user -> 409 EMAIL_UNAVAILABLE (details {}) BEFORE Cognito; no tenant provisioned', async () => {
    const mocks = makeMocks();
    mocks.tenantSvc.findByNameCaseInsensitive.mockResolvedValue(null);
    mocks.identitySvc.findUserByEmail.mockResolvedValue({
      id: 'u-owned', email: 'owner@acme.io', display_name: null, is_active: true, deactivated_at: null, created_at: '', updated_at: '',
    });
    const svc = buildService(mocks);
    const err = await svc
      .provisionTenantAndInviteOwner({
        name: 'AcmeCo',
        owner_email: ' Owner@Acme.IO ',
        actor_user_id: 'super-admin-1',
        request_id: TEST_REQUEST_ID,
        invite_owner: true,
      })
      .then(
        () => null,
        (e: unknown) => e as AramoError,
      );
    expect(err).toMatchObject({ code: 'EMAIL_UNAVAILABLE', statusCode: 409 });
    expect(err?.context?.details).toEqual({});
    expect(JSON.stringify(err?.context ?? {})).not.toContain('u-owned');
    // Probed on the NORMALIZED email; nothing provisioned, no Cognito call.
    expect(mocks.identitySvc.findUserByEmail).toHaveBeenCalledWith('owner@acme.io');
    expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
    expect(mocks.cognito.adminDeleteUser).not.toHaveBeenCalled();
    expect(mocks.tenantSvc.provisionTenant).not.toHaveBeenCalled();
    expect(mocks.identitySvc.createUserFromInvitation).not.toHaveBeenCalled();
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
        request_id: TEST_REQUEST_ID,
        invite_owner: true,
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
    // FIX_NOW-2: compensation re-reads the username and deletes only when the
    // sub equals the one this operation minted.
    mocks.cognito.adminGetUser.mockResolvedValue({ cognito_sub: 'cog-1' });
    mocks.tenantSvc.provisionTenant.mockRejectedValue(new Error('db down'));

    const svc = buildService(mocks);
    await expect(
      svc.provisionTenantAndInviteOwner({
        name: 'NewCo',
        owner_email: 'o@new.co',
        actor_user_id: 'a',
        request_id: TEST_REQUEST_ID,
        invite_owner: true,
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
        request_id: TEST_REQUEST_ID,
        invite_owner: true,
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
        request_id: TEST_REQUEST_ID,
        invite_owner: true,
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
      request_id: TEST_REQUEST_ID,
    });

    // D-AUTHZ-PLATFORM-INVITE-1: role_keys + request_id are threaded into
    // the IdentityService write call so the in-service D5 union check has
    // its inputs. (The unit-level mock doesn't run the validator; the
    // safe-by-construction proof lives in identity.service.spec.ts.)
    expect(mocks.identitySvc.createUserFromInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        role_keys: ['recruiter', 'account_manager'],
        role_ids: ['r-rec', 'r-am'],
        request_id: TEST_REQUEST_ID,
      }),
    );
    expect(out.status).toBe('invitation_sent');
    expect(out.role_keys).toEqual(['recruiter', 'account_manager']);
  });
});

// IC-1 PR-1 (D-AUTHZ-PLATFORM-INVITE-1 Amendment A1) — the idempotency cases
// as AMENDED: cases 1/2 (same tenant) and 4 (drift) are preserved; the former
// case 3 (`membership_added` for an existing user in a NEW tenant) is
// INVERTED into a refusal (409 EMAIL_UNAVAILABLE, details {}) that fires
// BEFORE any Cognito call. The identity probe is now the FIRST probe and runs
// on the normalized email.
const EXISTING_USER = {
  id: 'u-1', email: 'u@t.io', display_name: null, is_active: true, deactivated_at: null, created_at: '', updated_at: '',
};
const EXISTING_MEMBERSHIP_T1 = {
  id: 'mem-1', user_id: 'u-1', tenant_id: 't1', site_id: null, is_active: true, joined_at: '', deactivated_at: null, created_at: '', updated_at: '',
};

describe('PlatformInvitationService — inviteUserIntoTenant idempotency (proof 6 — Lead ruling 8 as amended by IC-1 PR-1)', () => {
  it('case 1: same email + same tenant + same roles -> 409 INVITATION_ALREADY_EXISTS; NO Cognito probe or create', async () => {
    const mocks = makeMocks();
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r-rec']);
    mocks.identitySvc.classifyInviteEmailOwnership.mockResolvedValue({
      kind: 'same_tenant',
      user: EXISTING_USER,
      membership: EXISTING_MEMBERSHIP_T1,
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
        request_id: TEST_REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: 'INVITATION_ALREADY_EXISTS',
      statusCode: 409,
    });
    // Same-tenant is resolved from identity alone — Cognito is never touched.
    expect(mocks.cognito.adminGetUser).not.toHaveBeenCalled();
    expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
    expect(mocks.cognito.adminDeleteUser).not.toHaveBeenCalled();
    expect(mocks.identitySvc.rejectCrossTenantInvitation).not.toHaveBeenCalled();
  });

  it('case 1 (Cognito-absent / identity-present, same tenant): still 409 INVITATION_ALREADY_EXISTS, NEVER AdminCreateUser + AdminDeleteUser', async () => {
    // A Pattern-2 (no-sub) tenant-tier invitee has an identity.User + a
    // membership in this tenant but NO Cognito user yet. Pre-IC-1 this state
    // fell through to the greenfield branch: AdminCreateUser, then a
    // User.email P2002 in the mirror, then AdminDeleteUser compensation and
    // an HTTP 500. Amendment A1 §4 requires it rejected without either call.
    const mocks = makeMocks();
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r-rec']);
    mocks.identitySvc.classifyInviteEmailOwnership.mockResolvedValue({
      kind: 'same_tenant',
      user: EXISTING_USER,
      membership: EXISTING_MEMBERSHIP_T1,
    });
    mocks.identitySvc.findRoleIdsForMembership.mockResolvedValue(['r-rec']);
    mocks.cognito.adminGetUser.mockResolvedValue(null);

    const svc = buildService(mocks);
    await expect(
      svc.inviteUserIntoTenant({
        tenant_id: 't1',
        email: 'u@t.io',
        role_keys: ['recruiter'],
        actor_user_id: 'sa',
        pool: 'tenant',
        request_id: TEST_REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: 'INVITATION_ALREADY_EXISTS', statusCode: 409 });
    expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
    expect(mocks.cognito.adminDeleteUser).not.toHaveBeenCalled();
    expect(mocks.identitySvc.createUserFromInvitation).not.toHaveBeenCalled();
  });

  it('case 2: same tenant + DIFFERENT roles -> reconcile (replaceMembershipRoles); NO Cognito call', async () => {
    // AUTHZ-1b fixture swap: hiring_manager retired -> account_manager.
    const mocks = makeMocks();
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r-rec', 'r-am']);
    mocks.identitySvc.classifyInviteEmailOwnership.mockResolvedValue({
      kind: 'same_tenant',
      user: EXISTING_USER,
      membership: EXISTING_MEMBERSHIP_T1,
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
      request_id: TEST_REQUEST_ID,
    });
    expect(out.status).toBe('roles_updated');
    expect(out.user_id).toBe('u-1');
    // D-AUTHZ-PLATFORM-INVITE-1: role_keys + request_id threaded.
    expect(mocks.identitySvc.replaceMembershipRoles).toHaveBeenCalledWith({
      membership_id: 'mem-1',
      tenant_id: 't1',
      role_keys: ['recruiter', 'account_manager'],
      role_ids: ['r-rec', 'r-am'],
      request_id: TEST_REQUEST_ID,
      // IC-2 PR-5 — a tenant-pool invite never asserts the platform tier.
      allow_platform_roles: false,
      // ROLES-1 PR-1 (§4.2) — the platform tier may grant/remove tenant_owner.
      owner_role_authority: 'platform',
    });
    expect(mocks.cognito.adminGetUser).not.toHaveBeenCalled();
    expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
  });

  it('case 3 (INVERTED by IC-1 PR-1): existing user owned by ANOTHER tenant -> 409 EMAIL_UNAVAILABLE, details {}, audit reason retained, ZERO Cognito calls, NO membership write', async () => {
    const mocks = makeMocks();
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r-rec']);
    mocks.identitySvc.classifyInviteEmailOwnership.mockResolvedValue({
      kind: 'other_tenant',
      user: EXISTING_USER,
      membership_tenant_ids: ['t-owner'],
    });
    mocks.cognito.adminGetUser.mockResolvedValue({ cognito_sub: 'sub-1' });

    const svc = buildService(mocks);
    const err = await svc
      .inviteUserIntoTenant({
        tenant_id: 't-new',
        email: 'u@t.io',
        role_keys: ['recruiter'],
        actor_user_id: 'sa',
        pool: 'tenant',
        request_id: TEST_REQUEST_ID,
      })
      .then(
        () => null,
        (e: unknown) => e as AramoError,
      );
    expect(err).toBeInstanceOf(AramoError);
    expect(err).toMatchObject({ code: 'EMAIL_UNAVAILABLE', statusCode: 409 });
    // EXACTLY `details: {}` — no tenant id, user id, role or Cognito state.
    expect(err?.context?.details).toEqual({});
    expect(JSON.stringify(err?.context ?? {})).not.toContain('t-owner');
    expect(JSON.stringify(err?.context ?? {})).not.toContain('u-1');
    // The refusal carried the ACTUAL reason + caller to the audit seam.
    expect(mocks.identitySvc.rejectCrossTenantInvitation).toHaveBeenCalledWith({
      tenant_id: 't-new',
      actor_user_id: 'sa',
      request_id: TEST_REQUEST_ID,
      tier: 'platform',
      existing: {
        kind: 'other_tenant',
        user: EXISTING_USER,
        membership_tenant_ids: ['t-owner'],
      },
      reason: 'existing_user_owned_by_other_tenant',
    });
    // ZERO Cognito side effects and ZERO identity writes.
    expect(mocks.cognito.adminGetUser).not.toHaveBeenCalled();
    expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
    expect(mocks.cognito.adminDeleteUser).not.toHaveBeenCalled();
    expect(mocks.identitySvc.createUserFromInvitation).not.toHaveBeenCalled();
    expect(mocks.identitySvc.replaceMembershipRoles).not.toHaveBeenCalled();
    // The retired entry point is not on the service surface at all.
    expect(
      (mocks.identitySvc as Record<string, unknown>)['addMembershipForExistingUser'],
    ).toBeUndefined();
  });

  it('case 3 edge: existing user with NO membership anywhere -> same refusal, reason existing_user_without_membership', async () => {
    const mocks = makeMocks();
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r-rec']);
    mocks.identitySvc.classifyInviteEmailOwnership.mockResolvedValue({
      kind: 'other_tenant',
      user: EXISTING_USER,
      membership_tenant_ids: [],
    });
    const svc = buildService(mocks);
    await expect(
      svc.inviteUserIntoTenant({
        tenant_id: 't-new',
        email: 'u@t.io',
        role_keys: ['recruiter'],
        actor_user_id: 'sa',
        pool: 'tenant',
        request_id: TEST_REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: 'EMAIL_UNAVAILABLE', statusCode: 409 });
    expect(mocks.identitySvc.rejectCrossTenantInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'existing_user_without_membership' }),
    );
    expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
  });

  it('normalization: the identity probe, the Cognito probe and the Cognito create all use the trim+lowercase email', async () => {
    const mocks = makeMocks();
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r-rec']);
    mocks.cognito.adminGetUser.mockResolvedValue(null);
    mocks.cognito.adminCreateUser.mockResolvedValue({ cognito_sub: 'sub-n' });
    mocks.identitySvc.createUserFromInvitation.mockResolvedValue({
      user: { ...EXISTING_USER, id: 'u-n', email: 'mixed@case.io' },
      membership_id: 'mem-n',
    });
    const svc = buildService(mocks);
    const out = await svc.inviteUserIntoTenant({
      tenant_id: 't1',
      email: '  Mixed@Case.IO ',
      role_keys: ['recruiter'],
      actor_user_id: 'sa',
      pool: 'tenant',
      request_id: TEST_REQUEST_ID,
    });
    expect(out.status).toBe('invitation_sent');
    expect(mocks.identitySvc.classifyInviteEmailOwnership).toHaveBeenCalledWith({
      email: 'mixed@case.io',
      tenant_id: 't1',
    });
    expect(mocks.cognito.adminGetUser).toHaveBeenCalledWith({
      pool: 'tenant',
      email: 'mixed@case.io',
    });
    expect(mocks.cognito.adminCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'mixed@case.io' }),
    );
    expect(mocks.identitySvc.createUserFromInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'mixed@case.io' }),
    );
  });

  // Gate-5 FIX_NOW-2 — Cognito compensation isolation. Compensation may delete
  // ONLY the identity THIS operation minted: it re-reads the username and
  // requires the sub to equal the one AdminCreateUser returned.
  function primeGreenfieldRace(mocks: Mocks, mintedSub: string): void {
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r-rec']);
    mocks.cognito.adminCreateUser.mockResolvedValue({ cognito_sub: mintedSub });
    mocks.identitySvc.createUserFromInvitation.mockRejectedValue(
      new AramoError(
        'EMAIL_UNAVAILABLE',
        'This email address is not available for invitation',
        409,
        { requestId: TEST_REQUEST_ID, details: {} },
      ),
    );
  }
  const RACE_ARGS = {
    tenant_id: 't1',
    email: 'race@t.io',
    role_keys: ['recruiter'],
    actor_user_id: 'sa',
    pool: 'tenant' as const,
    request_id: TEST_REQUEST_ID,
  };

  it('greenfield lost race: the governed 409 surfaces unchanged (never a 500) and compensation deletes the identity THIS operation minted (sub matches)', async () => {
    const mocks = makeMocks();
    primeGreenfieldRace(mocks, 'sub-race');
    // probe → absent; compensation re-read → the sub we just minted.
    mocks.cognito.adminGetUser
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ cognito_sub: 'sub-race' });
    const svc = buildService(mocks);
    await expect(svc.inviteUserIntoTenant(RACE_ARGS)).rejects.toMatchObject({
      code: 'EMAIL_UNAVAILABLE',
      statusCode: 409,
    });
    expect(mocks.cognito.adminGetUser).toHaveBeenCalledTimes(2);
    expect(mocks.cognito.adminDeleteUser).toHaveBeenCalledTimes(1);
    expect(mocks.cognito.adminDeleteUser).toHaveBeenCalledWith({
      pool: 'tenant',
      email: 'race@t.io',
    });
  });

  it('FIX_NOW-2: compensation NEVER deletes an identity whose sub differs from the one this operation minted', async () => {
    const mocks = makeMocks();
    primeGreenfieldRace(mocks, 'sub-race');
    mocks.cognito.adminGetUser
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ cognito_sub: 'sub-established-elsewhere' });
    const svc = buildService(mocks);
    await expect(svc.inviteUserIntoTenant(RACE_ARGS)).rejects.toMatchObject({
      code: 'EMAIL_UNAVAILABLE',
      statusCode: 409,
    });
    expect(mocks.cognito.adminDeleteUser).not.toHaveBeenCalled();
  });

  it('FIX_NOW-2: compensation is a no-op when the username no longer resolves (nothing to delete)', async () => {
    const mocks = makeMocks();
    primeGreenfieldRace(mocks, 'sub-race');
    mocks.cognito.adminGetUser.mockResolvedValue(null);
    const svc = buildService(mocks);
    await expect(svc.inviteUserIntoTenant(RACE_ARGS)).rejects.toMatchObject({
      code: 'EMAIL_UNAVAILABLE',
      statusCode: 409,
    });
    expect(mocks.cognito.adminDeleteUser).not.toHaveBeenCalled();
  });

  it('FIX_NOW-2: a pre-existing Cognito username makes AdminCreateUser fail (UsernameExistsException) → 502, NO identity write, NO compensation', async () => {
    const mocks = makeMocks();
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r-rec']);
    // Probe says absent (a registration landed in Cognito between the probe
    // and the create); Cognito refuses to overwrite the username.
    mocks.cognito.adminGetUser.mockResolvedValue(null);
    mocks.cognito.adminCreateUser.mockRejectedValue(
      Object.assign(new Error('User account already exists'), {
        name: 'UsernameExistsException',
      }),
    );
    const svc = buildService(mocks);
    await expect(svc.inviteUserIntoTenant(RACE_ARGS)).rejects.toMatchObject({
      code: 'COGNITO_PROVISION_FAILED',
      statusCode: 502,
    });
    expect(mocks.identitySvc.createUserFromInvitation).not.toHaveBeenCalled();
    expect(mocks.cognito.adminDeleteUser).not.toHaveBeenCalled();
  });

  it('FIX_NOW-2: the drift branch (existing Cognito sub reused) never compensates on a lost race — the established identity is untouched', async () => {
    const mocks = makeMocks();
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r-rec']);
    mocks.cognito.adminGetUser.mockResolvedValue({ cognito_sub: 'established-sub' });
    mocks.identitySvc.createUserFromInvitation.mockRejectedValue(
      new AramoError(
        'EMAIL_UNAVAILABLE',
        'This email address is not available for invitation',
        409,
        { requestId: TEST_REQUEST_ID, details: {} },
      ),
    );
    const svc = buildService(mocks);
    await expect(svc.inviteUserIntoTenant(RACE_ARGS)).rejects.toMatchObject({
      code: 'EMAIL_UNAVAILABLE',
      statusCode: 409,
    });
    expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
    expect(mocks.cognito.adminDeleteUser).not.toHaveBeenCalled();
  });

  it('case 4: drift (Cognito has user, identity does not) -> mirror identity from existing Cognito sub', async () => {
    const mocks = makeMocks();
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r-rec']);
    mocks.cognito.adminGetUser.mockResolvedValue({ cognito_sub: 'drift-sub' });
    mocks.identitySvc.classifyInviteEmailOwnership.mockResolvedValue({ kind: 'unregistered' });
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
      request_id: TEST_REQUEST_ID,
    });
    expect(out.status).toBe('invitation_sent');
    // The existing Cognito sub is reused (no AdminCreateUser).
    expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
    // D-AUTHZ-PLATFORM-INVITE-1: role_keys + request_id threaded.
    expect(mocks.identitySvc.createUserFromInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'cognito',
        provider_subject: 'drift-sub',
        role_keys: ['recruiter'],
        role_ids: ['r-rec'],
        request_id: TEST_REQUEST_ID,
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
      user: { id: 'plat-u', email: 'p@aramo.ai', display_name: null, is_active: true, deactivated_at: null, created_at: '', updated_at: '' },
      membership_id: 'plat-m',
    });

    const svc = buildService(mocks);
    await svc.invitePlatformAdmin({
      email: 'p@aramo.ai',
      actor_user_id: 'sa',
      request_id: TEST_REQUEST_ID,
    });

    expect(mocks.identitySvc.resolveRoleIdsByKeys).toHaveBeenCalledWith([
      'super_admin',
    ]);
    expect(mocks.cognito.adminCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({ pool: 'platform', email: 'p@aramo.ai' }),
    );
    // Sentinel tenant id is the PLATFORM_TENANT_SENTINEL_ID from libs/auth.
    // D-AUTHZ-PLATFORM-INVITE-1: super_admin is a see-all-tier role
    // (validator bypass); role_keys + request_id threaded uniformly.
    expect(mocks.identitySvc.createUserFromInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: '01900000-0000-7000-8000-000000000100',
        role_keys: ['super_admin'],
        role_ids: ['r-super'],
        request_id: TEST_REQUEST_ID,
      }),
    );
  });
});


// PLATFORM-UX-1 B-1c (directive R-8) — the platform-admin invite email-domain
// allowlist (PLATFORM_ADMIN_EMAIL_DOMAINS, default aramo.ai). A refused domain
// is a 400 VALIDATION_ERROR reason platform_admin_domain_not_allowed raised
// BEFORE any Cognito or identity call.
describe('PlatformInvitationService — platform admin invite email-domain allowlist (B-1c)', () => {
  const ENV_KEY = 'PLATFORM_ADMIN_EMAIL_DOMAINS';
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  function happyMocks(): Mocks {
    const mocks = makeMocks();
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r-super']);
    mocks.cognito.adminGetUser.mockResolvedValue(null);
    mocks.cognito.adminCreateUser.mockResolvedValue({ cognito_sub: 'plat-sub' });
    mocks.identitySvc.createUserFromInvitation.mockResolvedValue({
      user: { id: 'plat-u', email: 'x', display_name: null, is_active: true, deactivated_at: null, created_at: '', updated_at: '' },
      membership_id: 'plat-m',
    });
    return mocks;
  }

  async function expectRefused(mocks: Mocks, email: string): Promise<void> {
    const err = await buildService(mocks)
      .invitePlatformAdmin({ email, actor_user_id: 'sa', request_id: TEST_REQUEST_ID })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AramoError);
    expect((err as AramoError).code).toBe('VALIDATION_ERROR');
    expect((err as AramoError).statusCode).toBe(400);
    expect((err as AramoError).context.details).toEqual({ reason: 'platform_admin_domain_not_allowed' });
    // Refused before any side effect.
    expect(mocks.cognito.adminGetUser).not.toHaveBeenCalled();
    expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
    expect(mocks.identitySvc.findUserByEmail).not.toHaveBeenCalled();
    expect(mocks.identitySvc.createUserFromInvitation).not.toHaveBeenCalled();
  }

  it('default (unset): an aramo.ai address is allowed', async () => {
    const mocks = happyMocks();
    await buildService(mocks).invitePlatformAdmin({
      email: 'ops@aramo.ai',
      actor_user_id: 'sa',
      request_id: TEST_REQUEST_ID,
    });
    expect(mocks.cognito.adminCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({ pool: 'platform', email: 'ops@aramo.ai' }),
    );
  });

  it('default (unset): any other domain is refused 400 platform_admin_domain_not_allowed', async () => {
    await expectRefused(happyMocks(), 'ops@example.com');
  });

  it('a subdomain or look-alike of an allowed domain is refused (exact domain match)', async () => {
    await expectRefused(happyMocks(), 'ops@eu.aramo.ai');
    await expectRefused(happyMocks(), 'ops@notaramo.ai');
  });

  it('multiple domains: each listed domain is allowed, an unlisted one refused', async () => {
    process.env[ENV_KEY] = 'aramo.ai, astreinc.com';
    for (const email of ['a@aramo.ai', 'b@astreinc.com']) {
      const mocks = happyMocks();
      await buildService(mocks).invitePlatformAdmin({ email, actor_user_id: 'sa', request_id: TEST_REQUEST_ID });
      expect(mocks.cognito.adminCreateUser).toHaveBeenCalledTimes(1);
    }
    await expectRefused(happyMocks(), 'c@example.com');
  });

  it('a configured list replaces the default (aramo.ai not implied)', async () => {
    process.env[ENV_KEY] = 'astreinc.com';
    await expectRefused(happyMocks(), 'ops@aramo.ai');
  });

  it('case-insensitive on both the configured list and the email', async () => {
    process.env[ENV_KEY] = ' AstreInc.COM ,ARAMO.AI';
    const mocks = happyMocks();
    await buildService(mocks).invitePlatformAdmin({
      email: 'Ops@ARAMO.ai',
      actor_user_id: 'sa',
      request_id: TEST_REQUEST_ID,
    });
    expect(mocks.cognito.adminCreateUser).toHaveBeenCalledTimes(1);
  });

  it('the tenant-pool invite is NOT subject to the platform-admin allowlist', async () => {
    const mocks = happyMocks();
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r-rec']);
    await buildService(mocks).inviteUserIntoTenant({
      tenant_id: 'tenant-x',
      email: 'rec@example.com',
      role_keys: ['recruiter'],
      display_name: null,
      actor_user_id: 'sa',
      pool: 'tenant',
      request_id: TEST_REQUEST_ID,
    });
    expect(mocks.cognito.adminCreateUser).toHaveBeenCalledTimes(1);
  });
});

describe('platformAdminEmailDomains (B-1c env parsing)', () => {
  it('defaults to [aramo.ai] when unset or blank', () => {
    expect(platformAdminEmailDomains({})).toEqual(['aramo.ai']);
    expect(platformAdminEmailDomains({ PLATFORM_ADMIN_EMAIL_DOMAINS: '' })).toEqual(['aramo.ai']);
    expect(platformAdminEmailDomains({ PLATFORM_ADMIN_EMAIL_DOMAINS: ' , ,' })).toEqual(['aramo.ai']);
  });

  it('splits on commas, trims, lowercases, strips a leading @ and drops empty entries', () => {
    expect(
      platformAdminEmailDomains({ PLATFORM_ADMIN_EMAIL_DOMAINS: ' Aramo.AI ,, @astreinc.com ' }),
    ).toEqual(['aramo.ai', 'astreinc.com']);
  });
});

// IC-4 PR-9 — PERSONAL tenant provisioning through the saga: the personal-
// provider pre-check is skipped (P1-A1), the kind is forwarded to the identity
// spine, the capability set is CLOSED to [core, esign] (anything else → 400
// BEFORE any Cognito side effect), the owner receives org_admin (never an ATS
// role) and no ATS projection runs. BUSINESS is byte-identical to before.
describe('PlatformInvitationService — IC-4 PR-9 PERSONAL tenant provisioning', () => {
  function happyMocks() {
    const mocks = makeMocks();
    mocks.tenantSvc.findByNameCaseInsensitive.mockResolvedValue(null);
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['role-id-org-admin']);
    mocks.cognito.adminCreateUser.mockResolvedValue({ cognito_sub: 'cog-sub-p1' });
    mocks.tenantSvc.provisionTenant.mockResolvedValue({ id: 'tenant-p', name: 'Jane Doe', is_active: true, created_at: '', updated_at: '', identity_provider: null, status: 'PROVISIONED', kind: 'PERSONAL' });
    mocks.identitySvc.createUserFromInvitation.mockResolvedValue({
      user: { id: 'owner-p', email: 'jane.doe@gmail.com', display_name: 'Jane Doe', is_active: true, deactivated_at: null, created_at: '', updated_at: '' },
      membership_id: 'mem-p',
    });
    mocks.entitlementRepo.grantCapabilities.mockResolvedValue(undefined);
    return mocks;
  }
  it('PERSONAL + gmail owner, no capabilities → Cognito → identity (kind forwarded, tenant_owner + tenant_admin owner — ROLES-1 PR-2 §6) → [core, esign]; NO ATS projection; tenant_kind echoed', async () => {
    const mocks = happyMocks();
    const out = await buildService(mocks).provisionTenantAndInviteOwner({
      name: 'Jane Doe', owner_email: 'jane.doe@gmail.com', owner_display_name: 'Jane Doe',
      actor_user_id: 'super-admin-1', request_id: TEST_REQUEST_ID, invite_owner: true, kind: 'PERSONAL',
    });
    expect(mocks.cognito.adminCreateUser).toHaveBeenCalledWith(expect.objectContaining({ pool: 'tenant', email: 'jane.doe@gmail.com' }));
    expect(mocks.tenantSvc.provisionTenant).toHaveBeenCalledWith(expect.objectContaining({ kind: 'PERSONAL', owner_email: 'jane.doe@gmail.com' }));
    expect(mocks.identitySvc.resolveRoleIdsByKeys).toHaveBeenCalledWith(['tenant_owner', 'tenant_admin']);
    expect(mocks.identitySvc.createUserFromInvitation).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: 'tenant-p', role_keys: ['tenant_owner', 'tenant_admin'] }));
    expect(mocks.entitlementRepo.grantCapabilities).toHaveBeenCalledWith({ tenant_id: 'tenant-p', capabilities: ['core', 'sign'], granted_source: 'PROVISIONING', granted_by: 'super-admin-1' });
    expect(mocks.policyProvisioning.publishDefaultLifecyclePackage).not.toHaveBeenCalled();
    expect(out).toMatchObject({ tenant_id: 'tenant-p', tenant_kind: 'PERSONAL', capabilities: ['core', 'sign'] });
  });
  it('PERSONAL with capabilities [esign] (explicit) → [core, esign]; with [core, ats] → 400 personal_tenant_capability_not_allowed BEFORE Cognito and before any tenant/identity call', async () => {
    const ok = happyMocks();
    await buildService(ok).provisionTenantAndInviteOwner({ name: 'Jane Doe', owner_email: 'jane.doe@gmail.com', capabilities: ['sign'], actor_user_id: 'sa', request_id: TEST_REQUEST_ID, invite_owner: true, kind: 'PERSONAL' });
    expect(ok.entitlementRepo.grantCapabilities).toHaveBeenCalledWith({ tenant_id: 'tenant-p', capabilities: ['core', 'sign'], granted_source: 'PROVISIONING', granted_by: 'sa' });

    const refused = happyMocks();
    await expect(
      buildService(refused).provisionTenantAndInviteOwner({ name: 'Jane Doe', owner_email: 'jane.doe@gmail.com', capabilities: ['core', 'ats'], actor_user_id: 'sa', request_id: TEST_REQUEST_ID, invite_owner: true, kind: 'PERSONAL' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400, context: { details: { reason: 'personal_tenant_capability_not_allowed', capabilities: ['ats'] } } });
    expect(refused.cognito.adminCreateUser).not.toHaveBeenCalled();
    expect(refused.tenantSvc.provisionTenant).not.toHaveBeenCalled();
    expect(refused.identitySvc.createUserFromInvitation).not.toHaveBeenCalled();
    expect(refused.tenantSvc.findByNameCaseInsensitive).not.toHaveBeenCalled();
  });
  it('unknown kind → 400 invalid_tenant_kind before any side effect; BUSINESS (omitted) still refuses a personal-provider owner BEFORE Cognito', async () => {
    const m1 = happyMocks();
    await expect(
      buildService(m1).provisionTenantAndInviteOwner({ name: 'X', owner_email: 'owner@acme.io', actor_user_id: 'sa', request_id: TEST_REQUEST_ID, invite_owner: true, kind: 'ENTERPRISE' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { reason: 'invalid_tenant_kind' } } });
    expect(m1.cognito.adminCreateUser).not.toHaveBeenCalled();
    const m2 = happyMocks();
    await expect(
      buildService(m2).provisionTenantAndInviteOwner({ name: 'Acme', owner_email: 'founder@gmail.com', actor_user_id: 'sa', request_id: TEST_REQUEST_ID, invite_owner: true }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { reason: 'personal_email_not_allowed' } } });
    expect(m2.cognito.adminCreateUser).not.toHaveBeenCalled();
  });
  it('PERSONAL owner email already registered → 409 EMAIL_UNAVAILABLE (details {}) BEFORE Cognito (one identity, one tenant)', async () => {
    const mocks = happyMocks();
    mocks.identitySvc.findUserByEmail.mockResolvedValue({ id: 'u-existing', email: 'jane.doe@gmail.com' });
    await expect(
      buildService(mocks).provisionTenantAndInviteOwner({ name: 'Jane Doe', owner_email: 'jane.doe@gmail.com', actor_user_id: 'sa', request_id: TEST_REQUEST_ID, invite_owner: true, kind: 'PERSONAL' }),
    ).rejects.toMatchObject({ code: 'EMAIL_UNAVAILABLE', statusCode: 409, context: { details: {} } });
    expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
    expect(mocks.tenantSvc.provisionTenant).not.toHaveBeenCalled();
  });
  it('PERSONAL entitlement-grant failure → tenant SOFT-DISABLED (no product access from an incomplete provision)', async () => {
    const mocks = happyMocks();
    mocks.entitlementRepo.grantCapabilities.mockRejectedValue(new Error('entitlement down'));
    await expect(
      buildService(mocks).provisionTenantAndInviteOwner({ name: 'Jane Doe', owner_email: 'jane.doe@gmail.com', actor_user_id: 'sa', request_id: TEST_REQUEST_ID, invite_owner: true, kind: 'PERSONAL' }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', statusCode: 500 });
    expect(mocks.tenantSvc.deactivateTenant).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: 'tenant-p', reason: 'entitlement_grant_failed' }));
  });
});

// Domain-Enforcement P3 (LOCKED) §3/§7 (unit) — the console's BUSINESS pre-check
// order is name → email → domain, all BEFORE Cognito; PERSONAL skips the domain
// check; an orphaned tenant (identity-tx failure after the tenant insert) lapses.
describe('PlatformInvitationService — Domain-Enforcement P3 pre-checks', () => {
  const args = { name: 'AcmeCo', owner_email: 'owner@acme.io', actor_user_id: 'sa', request_id: TEST_REQUEST_ID, invite_owner: true };

  it('a held domain → 409 TENANT_DOMAIN_UNAVAILABLE before Cognito (no AdminCreateUser)', async () => {
    const mocks = makeMocks();
    mocks.tenantSvc.findByNameCaseInsensitive.mockResolvedValue(null);
    mocks.domainClaims.isDomainHeld.mockResolvedValue(true);
    await expect(buildService(mocks).provisionTenantAndInviteOwner(args)).rejects.toMatchObject({
      code: 'TENANT_DOMAIN_UNAVAILABLE',
      statusCode: 409,
      context: { details: { reason: 'organization_domain_taken' } },
    });
    expect(mocks.domainClaims.isDomainHeld).toHaveBeenCalledWith('acme.io');
    expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
    expect(mocks.tenantSvc.provisionTenant).not.toHaveBeenCalled();
  });

  it('order name → email → domain: a taken name or a registered email is reported first', async () => {
    const nameTaken = makeMocks();
    nameTaken.tenantSvc.findByNameCaseInsensitive.mockResolvedValue({ id: 't', name: 'AcmeCo' });
    nameTaken.identitySvc.findUserByEmail.mockResolvedValue({ id: 'u' });
    nameTaken.domainClaims.isDomainHeld.mockResolvedValue(true);
    await expect(buildService(nameTaken).provisionTenantAndInviteOwner(args)).rejects.toMatchObject({ code: 'TENANT_ALREADY_EXISTS' });
    expect(nameTaken.identitySvc.findUserByEmail).not.toHaveBeenCalled();
    expect(nameTaken.domainClaims.isDomainHeld).not.toHaveBeenCalled();

    const emailTaken = makeMocks();
    emailTaken.tenantSvc.findByNameCaseInsensitive.mockResolvedValue(null);
    emailTaken.identitySvc.findUserByEmail.mockResolvedValue({ id: 'u' });
    emailTaken.domainClaims.isDomainHeld.mockResolvedValue(true);
    await expect(buildService(emailTaken).provisionTenantAndInviteOwner(args)).rejects.toMatchObject({ code: 'EMAIL_UNAVAILABLE' });
    expect(emailTaken.domainClaims.isDomainHeld).not.toHaveBeenCalled();
    expect(emailTaken.cognito.adminCreateUser).not.toHaveBeenCalled();
  });

  it('PERSONAL never runs the domain check', async () => {
    const mocks = makeMocks();
    mocks.tenantSvc.findByNameCaseInsensitive.mockResolvedValue(null);
    mocks.domainClaims.isDomainHeld.mockResolvedValue(true);
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r1', 'r2']);
    mocks.cognito.adminCreateUser.mockResolvedValue({ cognito_sub: 'sub' });
    mocks.tenantSvc.provisionTenant.mockResolvedValue({ id: 'tp', name: 'Jane', is_active: true, created_at: '', updated_at: '' });
    mocks.identitySvc.createUserFromInvitation.mockResolvedValue({
      user: { id: 'u', email: 'jane@gmail.com', display_name: null, is_active: true, deactivated_at: null, created_at: '', updated_at: '' },
      membership_id: 'm',
    });
    await buildService(mocks).provisionTenantAndInviteOwner({ ...args, name: 'Jane', owner_email: 'jane@gmail.com', kind: 'PERSONAL' });
    expect(mocks.domainClaims.isDomainHeld).not.toHaveBeenCalled();
  });

  it('identity-tx failure after the tenant insert lapses the orphan tenant\'s claim (provisioning_failed) and compensates Cognito', async () => {
    const mocks = makeMocks();
    mocks.tenantSvc.findByNameCaseInsensitive.mockResolvedValue(null);
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r1', 'r2']);
    mocks.cognito.adminCreateUser.mockResolvedValue({ cognito_sub: 'sub' });
    mocks.cognito.adminGetUser.mockResolvedValue({ cognito_sub: 'sub' });
    mocks.tenantSvc.provisionTenant.mockResolvedValue({ id: 'orphan', name: 'AcmeCo', is_active: true, created_at: '', updated_at: '' });
    mocks.identitySvc.createUserFromInvitation.mockRejectedValue(new Error('boom'));
    await expect(buildService(mocks).provisionTenantAndInviteOwner(args)).rejects.toThrow('boom');
    expect(mocks.domainClaims.lapse).toHaveBeenCalledWith('orphan', 'provisioning_failed');
  });
});

// CCP-A9 (PBD §5.1 row A9; Inc-1 Closure Amendment A1 A1-1, A1-5) — the platform-admin invite
// accepts PLATFORM_ROLE_KEYS for a NEW arrival only; a CCP role arrives with its D9
// attestation, attested by an attested platform_owner inviter.
describe('CCP-A9 — platform-admin invite accepts platform role keys (new arrivals only)', () => {
  const HUMAN = 'a'.repeat(64);
  function greenfield(mocks: Mocks): void {
    mocks.identitySvc.resolveRoleIdsByKeys.mockImplementation(async (keys: string[]) => keys.map((k) => `r-${k}`));
    mocks.cognito.adminGetUser.mockResolvedValue(null);
    mocks.cognito.adminCreateUser.mockResolvedValue({ cognito_sub: 'plat-sub' });
    mocks.identitySvc.createUserFromInvitation.mockResolvedValue({
      user: { id: 'new-u', email: 'fin@aramo.ai', display_name: null, is_active: true, deactivated_at: null, created_at: '', updated_at: '' },
      membership_id: 'new-m',
    });
  }

  it.each([['platform_owner'], ['finance_admin'], ['commercial_ops'], ['catalog_manager'], ['support_admin'], ['read_only_auditor']])(
    'A9-INV-1 %s is accepted for a new arrival: minted on the sentinel, platform pool, and the D9 attestation is recorded (attested by the inviter)',
    async (role) => {
      const mocks = makeMocks();
      greenfield(mocks);
      const out = await buildService(mocks).invitePlatformAdmin({ email: 'fin@aramo.ai', role_keys: [role], human_ref_hash: HUMAN, actor_user_id: 'sa', request_id: TEST_REQUEST_ID });
      expect(out.status).toBe('invitation_sent');
      expect(mocks.identitySvc.createUserFromInvitation).toHaveBeenCalledWith(
        expect.objectContaining({ tenant_id: '01900000-0000-7000-8000-000000000100', role_keys: [role], allow_platform_roles: true }),
      );
      expect(mocks.cognito.adminCreateUser).toHaveBeenCalledWith(expect.objectContaining({ pool: 'platform' }));
      expect(mocks.operators.recordAttestation).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'new-u', human_ref_hash: HUMAN, method: 'PLATFORM_OWNER', attested_by: 'sa' }));
    },
  );

  it('A9-INV-2 role_keys omitted → ["super_admin"] (pre-A9 behaviour); no attestation and no inviter check', async () => {
    const mocks = makeMocks();
    greenfield(mocks);
    await buildService(mocks).invitePlatformAdmin({ email: 'sa2@aramo.ai', actor_user_id: 'sa', request_id: TEST_REQUEST_ID });
    expect(mocks.identitySvc.createUserFromInvitation).toHaveBeenCalledWith(expect.objectContaining({ role_keys: ['super_admin'] }));
    expect(mocks.operators.readOperatorNow).not.toHaveBeenCalled();
    expect(mocks.operators.recordAttestation).not.toHaveBeenCalled();
  });

  it('A9-INV-3 the @aramo.ai domain allowlist still applies to a commercial-role invite (refused before any side effect)', async () => {
    const mocks = makeMocks();
    greenfield(mocks);
    await expect(
      buildService(mocks).invitePlatformAdmin({ email: 'fin@example.com', role_keys: ['finance_admin'], human_ref_hash: HUMAN, actor_user_id: 'sa', request_id: TEST_REQUEST_ID }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { reason: 'platform_admin_domain_not_allowed' } } });
    expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
    expect(mocks.operators.recordAttestation).not.toHaveBeenCalled();
  });

  it('A9-INV-4 a commercial role without human_ref_hash → 400 human_ref_required; human_ref_hash without one → 400 human_ref_not_applicable; both before Cognito', async () => {
    const mocks = makeMocks();
    greenfield(mocks);
    const svc = buildService(mocks);
    await expect(svc.invitePlatformAdmin({ email: 'fin@aramo.ai', role_keys: ['finance_admin'], actor_user_id: 'sa', request_id: TEST_REQUEST_ID })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'human_ref_required' } },
    });
    await expect(svc.invitePlatformAdmin({ email: 'sa2@aramo.ai', human_ref_hash: HUMAN, actor_user_id: 'sa', request_id: TEST_REQUEST_ID })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'human_ref_not_applicable' } },
    });
    expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
  });

  it('A9-INV-5 the inviter must be an attested platform_owner to mint a commercial role (super_admin alone → 403 attester_not_platform_owner); an in-use human reference → 400', async () => {
    const mocks = makeMocks();
    greenfield(mocks);
    mocks.operators.readOperatorNow.mockResolvedValueOnce({ user_id: 'sa', attested: false, attestation_id: null, role_keys: ['super_admin'], scopes: [] });
    const svc = buildService(mocks);
    await expect(svc.invitePlatformAdmin({ email: 'fin@aramo.ai', role_keys: ['finance_admin'], human_ref_hash: HUMAN, actor_user_id: 'sa', request_id: TEST_REQUEST_ID })).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      context: { details: { reason: 'attester_not_platform_owner' } },
    });
    mocks.operators.readOperatorNow.mockResolvedValueOnce({ user_id: 'sa', attested: false, attestation_id: null, role_keys: ['platform_owner', 'super_admin'], scopes: [] });
    await expect(svc.invitePlatformAdmin({ email: 'fin@aramo.ai', role_keys: ['finance_admin'], human_ref_hash: HUMAN, actor_user_id: 'sa', request_id: TEST_REQUEST_ID })).rejects.toMatchObject({
      context: { details: { reason: 'attester_not_platform_owner' } },
    });
    mocks.operators.isHumanRefActive.mockResolvedValueOnce(true);
    await expect(svc.invitePlatformAdmin({ email: 'fin@aramo.ai', role_keys: ['finance_admin'], human_ref_hash: HUMAN, actor_user_id: 'sa', request_id: TEST_REQUEST_ID })).rejects.toMatchObject({
      context: { details: { reason: 'human_ref_in_use' } },
    });
    expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
  });

  it('A9-INV-6 an EXISTING platform member is refused 409 existing_platform_admin whatever the role set (no role replacement, no Cognito call)', async () => {
    for (const role_keys of [['finance_admin'], ['super_admin'], ['super_admin', 'platform_owner']]) {
      const mocks = makeMocks();
      greenfield(mocks);
      mocks.identitySvc.classifyInviteEmailOwnership.mockResolvedValue({ kind: 'same_tenant', user: { id: 'u-existing' }, membership: { id: 'm-existing' } });
      mocks.identitySvc.findRoleIdsForMembership.mockResolvedValue(['r-super_admin']);
      await expect(
        buildService(mocks).invitePlatformAdmin({ email: 'purush@aramo.ai', role_keys, ...(role_keys.includes('finance_admin') || role_keys.includes('platform_owner') ? { human_ref_hash: HUMAN } : {}), actor_user_id: 'sa', request_id: TEST_REQUEST_ID }),
      ).rejects.toMatchObject({ code: 'INVITATION_ALREADY_EXISTS', context: { details: { reason: 'existing_platform_admin' } } });
      expect(mocks.identitySvc.replaceMembershipRoles).not.toHaveBeenCalled();
      expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
      expect(mocks.operators.recordAttestation).not.toHaveBeenCalled();
    }
  });

  it('A9-INV-8 without the commercial operator store a commercial-role invite is refused (fail closed) before Cognito; a super_admin invite is unaffected', async () => {
    const mocks = makeMocks();
    greenfield(mocks);
    const svc = new PlatformInvitationService(
      mocks.cognito as unknown as CognitoAdminService,
      mocks.tenantSvc as never,
      mocks.identitySvc as never,
      mocks.entitlementRepo as never,
      mocks.policyProvisioning as never,
      mocks.domainClaims as never,
    );
    await expect(svc.invitePlatformAdmin({ email: 'fin@aramo.ai', role_keys: ['finance_admin'], human_ref_hash: HUMAN, actor_user_id: 'sa', request_id: TEST_REQUEST_ID })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      context: { details: { reason: 'commercial_operator_store_unavailable' } },
    });
    expect(mocks.cognito.adminCreateUser).not.toHaveBeenCalled();
    expect((await svc.invitePlatformAdmin({ email: 'sa2@aramo.ai', actor_user_id: 'sa', request_id: TEST_REQUEST_ID })).status).toBe('invitation_sent');
  });

  it('A9-INV-7 a tenant-pool same-tenant re-invite keeps its pre-A9 reconcile (the arrival-only rule is platform-pool only)', async () => {
    const mocks = makeMocks();
    mocks.identitySvc.resolveRoleIdsByKeys.mockResolvedValue(['r-recruiter']);
    mocks.identitySvc.classifyInviteEmailOwnership.mockResolvedValue({ kind: 'same_tenant', user: { id: 'u1' }, membership: { id: 'm1' } });
    mocks.identitySvc.findRoleIdsForMembership.mockResolvedValue(['r-other']);
    const out = await buildService(mocks).inviteUserIntoTenant({ tenant_id: 't1', email: 'r@acme.test', role_keys: ['recruiter'], actor_user_id: 'a', pool: 'tenant', request_id: TEST_REQUEST_ID });
    expect(out.status).toBe('roles_updated');
  });
});
