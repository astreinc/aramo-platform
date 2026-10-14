import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';

import { PlatformInvitationService } from '../app/platform/platform-invitation.service.js';
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
  // RTR-TEMPLATE-1 — step 5 (the default RTR DocumentTemplate copy).
  docTemplateProvisioning: {
    publishDefaultRtrTemplate: ReturnType<typeof vi.fn>;
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
    docTemplateProvisioning: {
      publishDefaultRtrTemplate: vi.fn(),
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
    mocks.docTemplateProvisioning as never,
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
        role_keys: ['tenant_owner'],
        role_ids: ['role-id-tenant-owner'],
        request_id: TEST_REQUEST_ID,
      }),
    );
    expect(mocks.entitlementRepo.grantCapabilities).toHaveBeenCalledWith({
      tenant_id: 'tenant-x',
      capabilities: ['core', 'ats', 'portal'],
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

  it('step 5 (RTR-TEMPLATE-1): an RTR-template publish failure soft-disables the tenant and throws INTERNAL_ERROR', async () => {
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
    // Step 4 (policy) succeeds; step 5 (RTR template) fails — e.g. the platform
    // sentinel has no active RTR template to copy.
    mocks.policyProvisioning.publishDefaultLifecyclePackage.mockResolvedValue(undefined);
    mocks.docTemplateProvisioning.publishDefaultRtrTemplate.mockRejectedValue(
      new Error('rtr_template_missing'),
    );

    const svc = buildService(mocks);
    await expect(
      svc.provisionTenantAndInviteOwner({
        name: 'RtrlessCo',
        owner_email: 'o@b.io',
        actor_user_id: 'sa',
        request_id: TEST_REQUEST_ID,
        invite_owner: true,
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });

    // Same compensation class as step 4: created-then-SOFT-DISABLED, not deleted.
    expect(mocks.tenantSvc.deactivateTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-z',
        reason: 'rtr_template_publish_failed',
      }),
    );
    expect(mocks.tenantSvc.recordOwnerInviteSent).not.toHaveBeenCalled();
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
      role_keys: ['recruiter', 'account_manager'],
      role_ids: ['r-rec', 'r-am'],
      request_id: TEST_REQUEST_ID,
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
      user: { id: 'plat-u', email: 'p@a.io', display_name: null, is_active: true, deactivated_at: null, created_at: '', updated_at: '' },
      membership_id: 'plat-m',
    });

    const svc = buildService(mocks);
    await svc.invitePlatformAdmin({
      email: 'p@a.io',
      actor_user_id: 'sa',
      request_id: TEST_REQUEST_ID,
    });

    expect(mocks.identitySvc.resolveRoleIdsByKeys).toHaveBeenCalledWith([
      'super_admin',
    ]);
    expect(mocks.cognito.adminCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({ pool: 'platform', email: 'p@a.io' }),
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
