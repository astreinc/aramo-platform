import { describe, expect, it, vi } from 'vitest';
import type { MailerPort } from '@aramo/mailer';

import type { IdentityAuditService } from '../lib/audit/identity-audit.service.js';
import type { MembershipDto } from '../lib/dto/membership.dto.js';
import type { IdentityRepository } from '../lib/identity.repository.js';
import { IdentityService } from '../lib/identity.service.js';
import type { TenantEntitlementReader } from '../lib/tenant-entitlement-reader.service.js';
import type { AuditFinancialsGate } from '../lib/tenant-user/audit-financials-gate.port.js';
import type { RoleBundleValidator } from '../lib/tenant-user/role-bundle-validator.js';
import type { TenantCognitoPort } from '../lib/tenant-user/tenant-cognito.port.js';
import { TenantUserLifecycleService } from '../lib/tenant-user/tenant-user-lifecycle.service.js';

// ROLES-1 PR-1 — Aramo-ROLES-1 Implementation Directive v1.0 (LOCKED) §4.2: only a caller
// holding tenant_owner may grant or remove tenant_owner (role PATCH, invite), or disable /
// revoke a user who holds it. Error: 403 INSUFFICIENT_PERMISSIONS, reason
// owner_role_requires_owner. The platform tier and system provisioning are not tenant-user
// callers and keep working. The REAL IdentityService and TenantUserLifecycleService run over
// a mocked repository so the rule is exercised end to end, with the writes asserted.

const TENANT = '01900000-0000-7000-8000-0000000000a1';
const ACTOR = '01900000-0000-7000-8000-0000000000aa';
const TARGET = '01900000-0000-7000-8000-0000000000bb';
const ACTOR_M = 'm-actor';
const TARGET_M = 'm-target';
const REQ = 'rq-roles1';

const OWNER_REFUSAL = {
  code: 'INSUFFICIENT_PERMISSIONS',
  statusCode: 403,
  context: { requestId: REQ, details: { reason: 'owner_role_requires_owner', role_key: 'tenant_owner' } },
};

function membership(id: string, user_id: string, over: Partial<MembershipDto> = {}): MembershipDto {
  return {
    id,
    user_id,
    tenant_id: TENANT,
    site_id: null,
    is_active: true,
    invite_status: 'ACTIVE',
    joined_at: 'x',
    deactivated_at: null,
    created_at: 'x',
    updated_at: 'x',
    ...over,
  };
}

function fixture(opts: {
  actorKeys: string[];
  targetKeys: string[];
  actorActive?: boolean;
  targetMembership?: Partial<MembershipDto>;
}) {
  const memberships: Record<string, MembershipDto> = {
    [ACTOR]: membership(ACTOR_M, ACTOR, { is_active: opts.actorActive ?? true }),
    [TARGET]: membership(TARGET_M, TARGET, opts.targetMembership ?? {}),
  };
  const keysByMembership: Record<string, string[]> = { [ACTOR_M]: opts.actorKeys, [TARGET_M]: opts.targetKeys };
  const repo = {
    findMembership: vi.fn(async (a: { user_id: string }) => memberships[a.user_id] ?? null),
    findRoleKeysForMembership: vi.fn(async (id: string) => keysByMembership[id] ?? []),
    replaceMembershipRoles: vi.fn().mockResolvedValue({ added_role_ids: [], removed_role_ids: [] }),
    disableMembership: vi.fn().mockResolvedValue({ changed: true, membership_id: TARGET_M, previously_active: true }),
    findUserById: vi.fn().mockResolvedValue({ id: TARGET, email: 't@acme.test', display_name: null, is_active: true, deactivated_at: null, created_at: 'x', updated_at: 'x' }),
    findUserByEmail: vi.fn().mockResolvedValue(null),
    findRoleIdsByKeys: vi.fn(async (keys: readonly string[]) => new Map(keys.map((k) => [k, `rid-${k}`]))),
    findMembershipTenantIdsForUser: vi.fn().mockResolvedValue([]),
    createUserWithMembership: vi.fn(),
    createInvitation: vi.fn(),
    findActiveInvitationByUserAndTenant: vi.fn().mockResolvedValue(null),
    revokeInvitation: vi.fn().mockResolvedValue({ changed: true }),
    findTenantAllowedDomainById: vi.fn().mockResolvedValue(null),
    // ROLES-1 PR-2 — the enable path.
    findTenantAccessStateById: vi.fn().mockResolvedValue({ status: 'ACTIVE', is_active: true }),
    reEnableMembership: vi.fn().mockResolvedValue({ membership_id: TARGET_M }),
  };
  const audit = { writeGlobalEvent: vi.fn(), writeEvent: vi.fn() } as unknown as IdentityAuditService;
  const roleBundle = { assertUnionNonInvertible: vi.fn().mockResolvedValue(undefined) } as unknown as RoleBundleValidator;
  const entitlements = { getCapabilities: vi.fn(async () => new Set(['core', 'ats'])) } as unknown as TenantEntitlementReader;
  const identity = new IdentityService(repo as unknown as IdentityRepository, audit, roleBundle, entitlements);
  const cognito = { adminDisableUser: vi.fn().mockResolvedValue(undefined), adminEnableUser: vi.fn().mockResolvedValue(undefined) };
  const lifecycle = new TenantUserLifecycleService(
    identity,
    cognito as unknown as TenantCognitoPort,
    { isFinancialsAuditEnabled: vi.fn().mockResolvedValue(true) } as unknown as AuditFinancialsGate,
    { send: vi.fn() } as unknown as MailerPort,
  );
  return { identity, lifecycle, repo, cognito };
}

const replaceArgs = (role_keys: string[], owner_role_authority?: Parameters<IdentityService['replaceMembershipRoles']>[0]['owner_role_authority']) => ({
  membership_id: TARGET_M,
  tenant_id: TENANT,
  role_keys,
  role_ids: role_keys.map((k) => `rid-${k}`),
  request_id: REQ,
  ...(owner_role_authority === undefined ? {} : { owner_role_authority }),
});

describe('ROLES-1 §4.2 — granting / removing tenant_owner (IdentityService.replaceMembershipRoles)', () => {
  it('a NON-owner admin granting tenant_owner → 403 owner_role_requires_owner; no write', async () => {
    const { identity, repo } = fixture({ actorKeys: ['tenant_admin'], targetKeys: ['recruiter'] });
    await expect(identity.replaceMembershipRoles(replaceArgs(['recruiter', 'tenant_owner'], { actor_user_id: ACTOR }))).rejects.toMatchObject({
      ...OWNER_REFUSAL,
      context: { ...OWNER_REFUSAL.context, details: { ...OWNER_REFUSAL.context.details, action: 'grant' } },
    });
    expect(repo.replaceMembershipRoles).not.toHaveBeenCalled();
  });

  it('an account_manager / recruiting_manager (holding tenant:admin:user-manage today) granting tenant_owner → 403', async () => {
    for (const k of ['account_manager', 'recruiting_manager']) {
      const { identity, repo } = fixture({ actorKeys: [k], targetKeys: ['recruiter'] });
      await expect(identity.replaceMembershipRoles(replaceArgs(['tenant_owner'], { actor_user_id: ACTOR }))).rejects.toMatchObject(OWNER_REFUSAL);
      expect(repo.replaceMembershipRoles).not.toHaveBeenCalled();
    }
  });

  it('an OWNER granting tenant_owner → proceeds to the write', async () => {
    const { identity, repo } = fixture({ actorKeys: ['tenant_owner'], targetKeys: ['recruiter'] });
    await identity.replaceMembershipRoles(replaceArgs(['recruiter', 'tenant_owner'], { actor_user_id: ACTOR }));
    expect(repo.replaceMembershipRoles).toHaveBeenCalledWith({ membership_id: TARGET_M, role_ids: ['rid-recruiter', 'rid-tenant_owner'], request_id: REQ });
  });

  it('a NON-owner REMOVING tenant_owner → 403 (action remove); an owner removing it → proceeds (the DB guards the last owner)', async () => {
    const denied = fixture({ actorKeys: ['tenant_admin'], targetKeys: ['tenant_owner', 'recruiter'] });
    await expect(denied.identity.replaceMembershipRoles(replaceArgs(['recruiter'], { actor_user_id: ACTOR }))).rejects.toMatchObject({
      context: { details: { reason: 'owner_role_requires_owner', action: 'remove' } },
    });
    expect(denied.repo.replaceMembershipRoles).not.toHaveBeenCalled();
    const allowed = fixture({ actorKeys: ['tenant_owner'], targetKeys: ['tenant_owner', 'recruiter'] });
    await allowed.identity.replaceMembershipRoles(replaceArgs(['recruiter'], { actor_user_id: ACTOR }));
    expect(allowed.repo.replaceMembershipRoles).toHaveBeenCalledTimes(1);
  });

  it('a change that leaves tenant_owner untouched needs no owner caller', async () => {
    const { identity, repo } = fixture({ actorKeys: ['tenant_admin'], targetKeys: ['tenant_owner', 'recruiter'] });
    await identity.replaceMembershipRoles(replaceArgs(['tenant_owner', 'account_manager'], { actor_user_id: ACTOR }));
    expect(repo.replaceMembershipRoles).toHaveBeenCalledTimes(1);
  });

  it('an INACTIVE owner membership does not authorize; an ABSENT authority does not authorize', async () => {
    const inactive = fixture({ actorKeys: ['tenant_owner'], targetKeys: [], actorActive: false });
    await expect(inactive.identity.replaceMembershipRoles(replaceArgs(['tenant_owner'], { actor_user_id: ACTOR }))).rejects.toMatchObject(OWNER_REFUSAL);
    const absent = fixture({ actorKeys: ['tenant_owner'], targetKeys: [] });
    await expect(absent.identity.replaceMembershipRoles(replaceArgs(['tenant_owner']))).rejects.toMatchObject(OWNER_REFUSAL);
    expect(absent.repo.replaceMembershipRoles).not.toHaveBeenCalled();
  });

  it('the platform tier and system provisioning keep working (no tenant-user caller, no reads)', async () => {
    for (const authority of ['platform', 'system'] as const) {
      const { identity, repo } = fixture({ actorKeys: [], targetKeys: [] });
      await identity.replaceMembershipRoles(replaceArgs(['tenant_owner'], authority));
      expect(repo.findRoleKeysForMembership).not.toHaveBeenCalled();
      expect(repo.replaceMembershipRoles).toHaveBeenCalledTimes(1);
    }
  });
});

describe('ROLES-1 §4.2 — invite as tenant_owner (assertRoleKeysAssignable on the create paths)', () => {
  it('a NON-owner inviting a tenant_owner → 403 before any write', async () => {
    const denied = fixture({ actorKeys: ['tenant_admin'], targetKeys: [] });
    await expect(
      denied.lifecycle.inviteTenantUser({ tenant_id: TENANT, email: 'new@acme.test', display_name: null, role_keys: ['tenant_owner'], actor_user_id: ACTOR, request_id: REQ }),
    ).rejects.toMatchObject(OWNER_REFUSAL);
    expect(denied.repo.createUserWithMembership).not.toHaveBeenCalled();
  });
  it('createUserFromInvitation under platform authority grants tenant_owner (provisioning path preserved)', async () => {
    const { identity, repo } = fixture({ actorKeys: [], targetKeys: [] });
    const err = new Error('stop after the gates');
    (repo as unknown as { createUserWithExternalIdentityAndMembership: ReturnType<typeof vi.fn> }).createUserWithExternalIdentityAndMembership = vi.fn().mockRejectedValue(err);
    await expect(
      identity.createUserFromInvitation({ email: 'owner@acme.test', display_name: null, provider: 'cognito', provider_subject: 's', tenant_id: TENANT, role_keys: ['tenant_owner'], role_ids: ['rid'], actor_user_id: 'platform-actor', request_id: REQ, owner_role_authority: 'platform' }),
    ).rejects.toBe(err); // passed every gate and reached the write
  });
});

describe('ROLES-1 §4.2 — disable / revoke of a tenant_owner (TenantUserLifecycleService)', () => {
  it('a NON-owner disabling an owner → 403; no identity flip, no Cognito call', async () => {
    const { lifecycle, repo, cognito } = fixture({ actorKeys: ['tenant_admin'], targetKeys: ['tenant_owner'] });
    await expect(
      lifecycle.disableTenantUser({ tenant_id: TENANT, user_id: TARGET, actor_user_id: ACTOR, reason: null, request_id: REQ }),
    ).rejects.toMatchObject({ ...OWNER_REFUSAL, context: { details: { action: 'disable' } } });
    expect(repo.disableMembership).not.toHaveBeenCalled();
    expect(cognito.adminDisableUser).not.toHaveBeenCalled();
  });

  it('an OWNER disabling another owner → proceeds (the DB guards the last owner)', async () => {
    const { lifecycle, repo } = fixture({ actorKeys: ['tenant_owner'], targetKeys: ['tenant_owner'] });
    await lifecycle.disableTenantUser({ tenant_id: TENANT, user_id: TARGET, actor_user_id: ACTOR, reason: null, request_id: REQ });
    expect(repo.disableMembership).toHaveBeenCalledWith({ user_id: TARGET, tenant_id: TENANT, request_id: REQ });
  });

  it('a NON-owner disabling a non-owner → proceeds (the rule is narrow)', async () => {
    const { lifecycle, repo } = fixture({ actorKeys: ['tenant_admin'], targetKeys: ['recruiter'] });
    await lifecycle.disableTenantUser({ tenant_id: TENANT, user_id: TARGET, actor_user_id: ACTOR, reason: null, request_id: REQ });
    expect(repo.disableMembership).toHaveBeenCalledTimes(1);
  });

  it('a NON-owner revoking a pending tenant_owner invite → 403; no revoke, no disable', async () => {
    const { lifecycle, repo } = fixture({ actorKeys: ['tenant_admin'], targetKeys: ['tenant_owner'], targetMembership: { invite_status: 'INVITED' } });
    await expect(lifecycle.revokeTenantInvite({ tenant_id: TENANT, user_id: TARGET, actor_user_id: ACTOR, request_id: REQ })).rejects.toMatchObject({
      ...OWNER_REFUSAL,
      context: { details: { action: 'revoke' } },
    });
    expect(repo.revokeInvitation).not.toHaveBeenCalled();
    expect(repo.disableMembership).not.toHaveBeenCalled();
  });

  it('an OWNER revoking a pending tenant_owner invite → proceeds', async () => {
    const { lifecycle, repo } = fixture({ actorKeys: ['tenant_owner'], targetKeys: ['tenant_owner'], targetMembership: { invite_status: 'INVITED' } });
    await lifecycle.revokeTenantInvite({ tenant_id: TENANT, user_id: TARGET, actor_user_id: ACTOR, request_id: REQ });
    expect(repo.disableMembership).toHaveBeenCalledWith({ user_id: TARGET, tenant_id: TENANT, request_id: REQ });
  });
});

// ROLES-1 PR-2 (§4.2; the PR-1 gap) — POST :user_id/enable re-activates a DISABLED
// membership; when it holds tenant_owner that restores an owner, so only a tenant_owner
// caller may do it (same rule as disable / revoke).
describe('ROLES-1 §4.2 — enable of a disabled tenant_owner (TenantUserLifecycleService)', () => {
  it('a NON-owner re-enabling a disabled owner → 403; no identity flip, no Cognito call', async () => {
    const { lifecycle, repo, cognito } = fixture({ actorKeys: ['tenant_admin'], targetKeys: ['tenant_owner'], targetMembership: { is_active: false } });
    await expect(lifecycle.enableTenantUser({ tenant_id: TENANT, user_id: TARGET, actor_user_id: ACTOR, request_id: REQ })).rejects.toMatchObject({
      ...OWNER_REFUSAL,
      context: { details: { action: 'enable' } },
    });
    expect(repo.reEnableMembership).not.toHaveBeenCalled();
    expect(cognito.adminEnableUser).not.toHaveBeenCalled();
  });

  it('an OWNER re-enabling a disabled owner → proceeds', async () => {
    const { lifecycle, repo, cognito } = fixture({ actorKeys: ['tenant_owner'], targetKeys: ['tenant_owner'], targetMembership: { is_active: false } });
    await lifecycle.enableTenantUser({ tenant_id: TENANT, user_id: TARGET, actor_user_id: ACTOR, request_id: REQ });
    expect(repo.reEnableMembership).toHaveBeenCalledTimes(1);
    expect(cognito.adminEnableUser).toHaveBeenCalledTimes(1);
  });

  it('a NON-owner re-enabling a disabled non-owner → proceeds (the rule is narrow)', async () => {
    const { lifecycle, repo } = fixture({ actorKeys: ['tenant_admin'], targetKeys: ['recruiter'], targetMembership: { is_active: false } });
    await lifecycle.enableTenantUser({ tenant_id: TENANT, user_id: TARGET, actor_user_id: ACTOR, request_id: REQ });
    expect(repo.reEnableMembership).toHaveBeenCalledTimes(1);
  });

  it('re-enabling an ALREADY ACTIVE owner is an idempotent no-op and needs no owner caller', async () => {
    const { lifecycle, repo } = fixture({ actorKeys: ['tenant_admin'], targetKeys: ['tenant_owner'] });
    await lifecycle.enableTenantUser({ tenant_id: TENANT, user_id: TARGET, actor_user_id: ACTOR, request_id: REQ });
    expect(repo.reEnableMembership).toHaveBeenCalledTimes(1);
  });
});

// ROLES-1 PR-3 (routine safeguard, TD) — granting or removing tenant_admin (the
// ORGANIZATION administrator, organization-wide after PR-2) requires the caller to hold
// tenant_owner or tenant_admin; the platform tier and system provisioning keep working.
// Error: 403 INSUFFICIENT_PERMISSIONS, reason org_role_requires_org_admin. tenant_owner
// stays owner-only (above).
const ORG_ADMIN_REFUSAL = {
  code: 'INSUFFICIENT_PERMISSIONS',
  statusCode: 403,
  context: { requestId: REQ, details: { reason: 'org_role_requires_org_admin', role_key: 'tenant_admin' } },
};

describe('ROLES-1 PR-3 — granting / removing tenant_admin (organization administrator)', () => {
  it('an account_manager / recruiting_manager (tenant:admin:user-manage, no organization role) cannot grant tenant_admin → 403; no write', async () => {
    for (const k of ['account_manager', 'recruiting_manager']) {
      const { identity, repo } = fixture({ actorKeys: [k], targetKeys: ['recruiter'] });
      await expect(identity.replaceMembershipRoles(replaceArgs(['recruiter', 'tenant_admin'], { actor_user_id: ACTOR }))).rejects.toMatchObject({
        ...ORG_ADMIN_REFUSAL,
        context: { ...ORG_ADMIN_REFUSAL.context, details: { ...ORG_ADMIN_REFUSAL.context.details, action: 'grant' } },
      });
      expect(repo.replaceMembershipRoles).not.toHaveBeenCalled();
    }
  });

  it('an account_manager cannot remove tenant_admin → 403 (action remove)', async () => {
    const { identity, repo } = fixture({ actorKeys: ['account_manager'], targetKeys: ['tenant_admin', 'recruiter'] });
    await expect(identity.replaceMembershipRoles(replaceArgs(['recruiter'], { actor_user_id: ACTOR }))).rejects.toMatchObject({
      context: { details: { reason: 'org_role_requires_org_admin', action: 'remove' } },
    });
    expect(repo.replaceMembershipRoles).not.toHaveBeenCalled();
  });

  it('a tenant_admin may grant and remove tenant_admin; a tenant_owner may too', async () => {
    for (const actorKeys of [['tenant_admin'], ['tenant_owner']]) {
      const grant = fixture({ actorKeys, targetKeys: ['recruiter'] });
      await grant.identity.replaceMembershipRoles(replaceArgs(['recruiter', 'tenant_admin'], { actor_user_id: ACTOR }));
      expect(grant.repo.replaceMembershipRoles).toHaveBeenCalledTimes(1);
      const remove = fixture({ actorKeys, targetKeys: ['tenant_admin', 'recruiter'] });
      await remove.identity.replaceMembershipRoles(replaceArgs(['recruiter'], { actor_user_id: ACTOR }));
      expect(remove.repo.replaceMembershipRoles).toHaveBeenCalledTimes(1);
    }
  });

  it('a tenant_admin still cannot grant tenant_owner (owner-only, PR-1)', async () => {
    const { identity, repo } = fixture({ actorKeys: ['tenant_admin'], targetKeys: ['recruiter'] });
    await expect(identity.replaceMembershipRoles(replaceArgs(['tenant_owner', 'tenant_admin'], { actor_user_id: ACTOR }))).rejects.toMatchObject(OWNER_REFUSAL);
    expect(repo.replaceMembershipRoles).not.toHaveBeenCalled();
  });

  it('a change that leaves tenant_admin untouched needs no organization-role caller', async () => {
    const { identity, repo } = fixture({ actorKeys: ['account_manager'], targetKeys: ['tenant_admin', 'recruiter'] });
    await identity.replaceMembershipRoles(replaceArgs(['tenant_admin', 'sourcer'], { actor_user_id: ACTOR }));
    expect(repo.replaceMembershipRoles).toHaveBeenCalledTimes(1);
  });

  it('an INACTIVE organization-admin membership or an ABSENT authority does not authorize', async () => {
    const inactive = fixture({ actorKeys: ['tenant_admin'], targetKeys: [], actorActive: false });
    await expect(inactive.identity.replaceMembershipRoles(replaceArgs(['tenant_admin'], { actor_user_id: ACTOR }))).rejects.toMatchObject(ORG_ADMIN_REFUSAL);
    const absent = fixture({ actorKeys: ['tenant_admin'], targetKeys: [] });
    await expect(absent.identity.replaceMembershipRoles(replaceArgs(['tenant_admin']))).rejects.toMatchObject(ORG_ADMIN_REFUSAL);
    expect(absent.repo.replaceMembershipRoles).not.toHaveBeenCalled();
  });

  it('the platform tier and system provisioning keep working', async () => {
    for (const authority of ['platform', 'system'] as const) {
      const { identity, repo } = fixture({ actorKeys: [], targetKeys: [] });
      await identity.replaceMembershipRoles(replaceArgs(['tenant_owner', 'tenant_admin'], authority));
      expect(repo.replaceMembershipRoles).toHaveBeenCalledTimes(1);
    }
  });

  it('PATCH roles (assignTenantUserRoles) and invite by an account_manager naming tenant_admin → 403 before any write', async () => {
    const patch = fixture({ actorKeys: ['account_manager'], targetKeys: ['recruiter'] });
    await expect(
      patch.lifecycle.assignTenantUserRoles({ tenant_id: TENANT, user_id: TARGET, role_keys: ['recruiter', 'tenant_admin'], actor_user_id: ACTOR, request_id: REQ }),
    ).rejects.toMatchObject(ORG_ADMIN_REFUSAL);
    expect(patch.repo.replaceMembershipRoles).not.toHaveBeenCalled();
    const invite = fixture({ actorKeys: ['recruiting_manager'], targetKeys: [] });
    await expect(
      invite.lifecycle.inviteTenantUser({ tenant_id: TENANT, email: 'new@acme.test', display_name: null, role_keys: ['tenant_admin'], actor_user_id: ACTOR, request_id: REQ }),
    ).rejects.toMatchObject(ORG_ADMIN_REFUSAL);
    expect(invite.repo.createUserWithMembership).not.toHaveBeenCalled();
  });

  it('the retired sign_owner key does not resolve (inactive row) — never assignable', async () => {
    const { identity, repo } = fixture({ actorKeys: ['tenant_owner'], targetKeys: [] });
    repo.findRoleIdsByKeys.mockImplementation(async (keys: readonly string[]) => new Map(keys.filter((k) => k !== 'sign_owner').map((k) => [k, `rid-${k}`])));
    await expect(identity.resolveRoleIdsByKeys(['sign_owner'])).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { missing_role_keys: ['sign_owner'] } } });
  });
});
