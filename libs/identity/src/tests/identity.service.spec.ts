import { describe, expect, it, vi } from 'vitest';

import { IdentityAuditService } from '../lib/audit/identity-audit.service.js';
import { IdentityRepository } from '../lib/identity.repository.js';
import {
  IdentityService,
  isUserEmailUniqueViolation,
} from '../lib/identity.service.js';
import type { UserDto } from '../lib/dto/user.dto.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';
import { RoleBundleValidator } from '../lib/tenant-user/role-bundle-validator.js';

const USER_ID = '01900000-0000-7000-8000-000000000002';
const COGNITO_SUB = 'fixed-dev-cognito-sub-01';

function makeUserDto(): UserDto {
  return {
    id: USER_ID,
    email: 'admin@aramo.dev',
    display_name: 'Aramo Dev Admin',
    is_active: true,
    deactivated_at: null,
    created_at: '2026-05-12T00:00:00.000Z',
    updated_at: '2026-05-12T00:00:00.000Z',
  };
}

// makePrisma exposes only the slice of the client surface that any
// IdentityService call could legitimately reach via the repo. Tests assert on
// what's called AND what isn't — the .create absence guard depends on the
// shape being complete enough that an unintended .create call would surface
// as a mock-method hit.
function makePrisma(externalIdentityFindUnique: ReturnType<typeof vi.fn>): {
  prisma: PrismaService;
  createSpies: {
    user: ReturnType<typeof vi.fn>;
    externalIdentity: ReturnType<typeof vi.fn>;
    tenant: ReturnType<typeof vi.fn>;
  };
} {
  const userCreate = vi.fn();
  const externalIdentityCreate = vi.fn();
  const tenantCreate = vi.fn();
  const prisma = {
    externalIdentity: { findUnique: externalIdentityFindUnique, create: externalIdentityCreate },
    user: { create: userCreate },
    tenant: { create: tenantCreate },
  } as unknown as PrismaService;
  return {
    prisma,
    createSpies: {
      user: userCreate,
      externalIdentity: externalIdentityCreate,
      tenant: tenantCreate,
    },
  };
}

describe('IdentityService.resolveUser', () => {
  // Test 1: returns User when ExternalIdentity exists.
  it('returns User when ExternalIdentity exists', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'ei-1',
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
      user_id: USER_ID,
      email_snapshot: 'admin@aramo.dev',
      created_at: new Date(),
      updated_at: new Date(),
      user: {
        id: USER_ID,
        email: 'admin@aramo.dev',
        display_name: 'Aramo Dev Admin',
        is_active: true,
        deactivated_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
    const { prisma } = makePrisma(findUnique);
    const service = new IdentityService(
      new IdentityRepository(prisma),
      undefined as unknown as IdentityAuditService,
      undefined as unknown as RoleBundleValidator,
    );

    const result = await service.resolveUser({
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
    });

    expect(result?.id).toBe(USER_ID);
    expect(result?.email).toBe('admin@aramo.dev');
  });

  // Test 2: returns null when no ExternalIdentity mapping.
  it('returns null when no ExternalIdentity mapping', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const { prisma } = makePrisma(findUnique);
    const service = new IdentityService(
      new IdentityRepository(prisma),
      undefined as unknown as IdentityAuditService,
      undefined as unknown as RoleBundleValidator,
    );

    const result = await service.resolveUser({
      provider: 'cognito',
      provider_subject: 'unknown-sub',
    });

    expect(result).toBeNull();
  });

  // Test 3: resolveUser does NOT call any .create method (no auto-create).
  it('does NOT call any .create method (no auto-create assertion)', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const { prisma, createSpies } = makePrisma(findUnique);
    const service = new IdentityService(
      new IdentityRepository(prisma),
      undefined as unknown as IdentityAuditService,
      undefined as unknown as RoleBundleValidator,
    );

    await service.resolveUser({ provider: 'cognito', provider_subject: 'never-seen' });

    expect(createSpies.user).not.toHaveBeenCalled();
    expect(createSpies.externalIdentity).not.toHaveBeenCalled();
    expect(createSpies.tenant).not.toHaveBeenCalled();
  });

  // Test 9 (service portion): returns a DTO, not a Prisma model. Verified by
  // shape — ISO-string created_at, no `_count` or relation fields surfaced.
  it('returns a DTO shape (ISO timestamps, no Prisma model fields leaked)', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'ei-2',
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
      user_id: USER_ID,
      email_snapshot: 'admin@aramo.dev',
      created_at: new Date('2026-05-12T00:00:00Z'),
      updated_at: new Date('2026-05-12T00:00:00Z'),
      user: {
        id: USER_ID,
        email: 'admin@aramo.dev',
        display_name: 'Aramo Dev Admin',
        is_active: true,
        deactivated_at: null,
        created_at: new Date('2026-05-12T00:00:00Z'),
        updated_at: new Date('2026-05-12T00:00:00Z'),
      },
    });
    const { prisma } = makePrisma(findUnique);
    const service = new IdentityService(
      new IdentityRepository(prisma),
      undefined as unknown as IdentityAuditService,
      undefined as unknown as RoleBundleValidator,
    );

    const result = (await service.resolveUser({
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
    })) satisfies UserDto | null;

    expect(result).not.toBeNull();
    if (result === null) return;
    // ISO string, not Date
    expect(typeof result.created_at).toBe('string');
    expect(typeof result.updated_at).toBe('string');
    // No `_count` or relation fields
    expect(result).not.toHaveProperty('memberships');
    expect(result).not.toHaveProperty('external_identities');
    expect(result).toEqual(makeUserDto());
  });
});

// D-AUTHZ-PLATFORM-INVITE-1 (Gate-6) — safe-by-construction proofs.
//
// The §2 in-service ruling moved assertUnionNonInvertible INTO the three
// membership-role-write methods (createUserFromInvitation /
// addMembershipForExistingUser / replaceMembershipRoles). This suite is
// the load-bearing proof: each write method directly rejects an invertible
// scope union BEFORE any DB write or audit emission. Every caller is
// covered without remembering to call the validator — the prior caller-
// side contract (documented but unenforced; honored by the tenant tier,
// silently violated by the platform tier) is retired.
//
// Test shape: a real RoleBundleValidator wraps a mocked PrismaService that
// returns role-scope data; the IdentityRepository write spies are asserted
// NEVER-CALLED on an invertible bundle; the IdentityAuditService is
// asserted NEVER-CALLED on rejection (audit-on-success preserved).
// (Imports for IdentityAuditService + RoleBundleValidator are at file
// top; this suite uses them as values, not types.)

interface InServiceFixture {
  identitySvc: IdentityService;
  repoSpies: {
    createUserWithExternalIdentityAndMembership: ReturnType<typeof vi.fn>;
    createUserWithMembership: ReturnType<typeof vi.fn>;
    createInvitation: ReturnType<typeof vi.fn>;
    replaceMembershipRoles: ReturnType<typeof vi.fn>;
    findMembership: ReturnType<typeof vi.fn>;
    // IC-1 PR-1 — the ownership reads behind the one-User-one-tenant guard.
    findUserByEmail: ReturnType<typeof vi.fn>;
    findMembershipTenantIdsForUser: ReturnType<typeof vi.fn>;
  };
  auditSpies: {
    writeGlobalEvent: ReturnType<typeof vi.fn>;
    writeEvent: ReturnType<typeof vi.fn>;
  };
}

// Build the test fixture: a real RoleBundleValidator wrapping a mock
// PrismaService that returns the given role->scopes map; an IdentityService
// constructed with a mocked IdentityRepository (write spies are vi.fn()s
// asserted on) + a mocked IdentityAuditService (write spies asserted on
// for audit-on-success-only). The validator's findMany returns the role
// rows in the shape the validator's union-scope reducer expects:
//   { id, key, role_scopes: [{ scope: { key } }] }
function buildInServiceFixture(
  rolesByKey: Record<string, readonly string[]>,
): InServiceFixture {
  const validatorPrisma = {
    role: {
      findMany: vi.fn().mockImplementation(
        async (args: { where: { key: { in: string[] } } }) => {
          return args.where.key.in
            .filter((k) => k in rolesByKey)
            .map((k) => ({
              id: `role-${k}`,
              key: k,
              role_scopes: (rolesByKey[k] ?? []).map((scopeKey) => ({
                scope: { key: scopeKey },
              })),
            }));
        },
      ),
    },
  } as unknown as PrismaService;
  const validator = new RoleBundleValidator(validatorPrisma);

  const repoSpies = {
    createUserWithExternalIdentityAndMembership: vi.fn(),
    createUserWithMembership: vi.fn(),
    createInvitation: vi.fn(),
    replaceMembershipRoles: vi.fn(),
    findMembership: vi.fn(),
    // Defaults: the email is unregistered (the pre-IC-1 proofs proceed to
    // the write exactly as before); guard tests override per case.
    findUserByEmail: vi.fn().mockResolvedValue(null),
    findMembershipTenantIdsForUser: vi.fn().mockResolvedValue([]),
  };
  const repo = repoSpies as unknown as IdentityRepository;

  const auditSpies = {
    writeGlobalEvent: vi.fn(),
    writeEvent: vi.fn(),
  };
  const audit = auditSpies as unknown as IdentityAuditService;

  const identitySvc = new IdentityService(repo, audit, validator);
  return { identitySvc, repoSpies, auditSpies };
}

// Canonical D5-leak shape: one role grants compensation:view:pay, another
// grants a spread scope; their union reconstructs the leak the D5
// invariant exists to prevent.
const INVERTIBLE_ROLES = {
  pay_holder: ['compensation:view:pay'],
  spread_holder: ['compensation:view:spread:amount'],
} as const;

// Canonical safe shape: two roles whose union holds NO spread (or no
// view:pay) — passes the validator cleanly.
const SAFE_MULTI_ROLES = {
  recruiter: ['recruiter:talent:read', 'compensation:view:pay'],
  back_office: ['activity:read', 'compensation:view:pay'],
} as const;

const REQUEST_ID = 'rq-d-authz-001';

describe('IdentityService.createUserFromInvitation — D5 in-service safe-by-construction', () => {
  it('invertible union → VALIDATION_ERROR; ZERO DB writes; ZERO audit emissions', async () => {
    const { identitySvc, repoSpies, auditSpies } = buildInServiceFixture(
      INVERTIBLE_ROLES,
    );
    await expect(
      identitySvc.createUserFromInvitation({
        email: 'bad@invite.io',
        display_name: null,
        provider: 'cognito',
        provider_subject: 'cog-bad-1',
        tenant_id: '01900000-0000-7000-8000-000000000001',
        role_keys: ['pay_holder', 'spread_holder'],
        role_ids: ['role-pay_holder', 'role-spread_holder'],
        actor_user_id: 'super-admin-1',
        request_id: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      context: {
        requestId: REQUEST_ID,
        details: { reason: 'invertible_role_union' },
      },
    });
    // THE SAFE-BY-CONSTRUCTION INVARIANT — no DB write, no audit.
    expect(
      repoSpies.createUserWithExternalIdentityAndMembership,
    ).not.toHaveBeenCalled();
    expect(auditSpies.writeGlobalEvent).not.toHaveBeenCalled();
    expect(auditSpies.writeEvent).not.toHaveBeenCalled();
  });

  it('safe multi-role union → DB write proceeds; audit emissions fire', async () => {
    const { identitySvc, repoSpies, auditSpies } = buildInServiceFixture(
      SAFE_MULTI_ROLES,
    );
    repoSpies.createUserWithExternalIdentityAndMembership.mockResolvedValue({
      user: {
        id: 'u-1',
        email: 'good@invite.io',
        display_name: null,
        is_active: true,
        deactivated_at: null,
        created_at: '',
        updated_at: '',
      },
      membership_id: 'mem-1',
    });
    const result = await identitySvc.createUserFromInvitation({
      email: 'good@invite.io',
      display_name: null,
      provider: 'cognito',
      provider_subject: 'cog-good-1',
      tenant_id: '01900000-0000-7000-8000-000000000001',
      role_keys: ['recruiter', 'back_office'],
      role_ids: ['role-recruiter', 'role-back_office'],
      actor_user_id: 'super-admin-1',
      request_id: REQUEST_ID,
    });
    expect(result.membership_id).toBe('mem-1');
    expect(
      repoSpies.createUserWithExternalIdentityAndMembership,
    ).toHaveBeenCalledTimes(1);
    // Audit fires for the 4 standard events.
    expect(auditSpies.writeGlobalEvent.mock.calls.length).toBeGreaterThan(0);
    expect(auditSpies.writeEvent.mock.calls.length).toBeGreaterThan(0);
  });

  it('single-role invite → validator no-ops (length<2); DB write proceeds', async () => {
    const { identitySvc, repoSpies } = buildInServiceFixture(SAFE_MULTI_ROLES);
    repoSpies.createUserWithExternalIdentityAndMembership.mockResolvedValue({
      user: {
        id: 'u-1',
        email: 'single@invite.io',
        display_name: null,
        is_active: true,
        deactivated_at: null,
        created_at: '',
        updated_at: '',
      },
      membership_id: 'mem-1',
    });
    await identitySvc.createUserFromInvitation({
      email: 'single@invite.io',
      display_name: null,
      provider: 'cognito',
      provider_subject: 'cog-single-1',
      tenant_id: '01900000-0000-7000-8000-000000000001',
      role_keys: ['recruiter'],
      role_ids: ['role-recruiter'],
      actor_user_id: 'super-admin-1',
      request_id: REQUEST_ID,
    });
    expect(
      repoSpies.createUserWithExternalIdentityAndMembership,
    ).toHaveBeenCalledTimes(1);
  });
});

// IC-1 PR-1 (D-AUTHZ-PLATFORM-INVITE-1 Amendment A1 §2): the former
// addMembershipForExistingUser suite is retired with the method. The retired
// entry point (and its repository writer) must be ABSENT from the surface.
describe('IdentityService — IC-1 PR-1 retired entry points', () => {
  it('addMembershipForExistingUser / createMembershipForExistingUser are not on the service / repository surface', () => {
    const { identitySvc } = buildInServiceFixture(SAFE_MULTI_ROLES);
    expect(
      (identitySvc as unknown as Record<string, unknown>)['addMembershipForExistingUser'],
    ).toBeUndefined();
    expect(
      (IdentityRepository.prototype as unknown as Record<string, unknown>)[
        'createMembershipForExistingUser'
      ],
    ).toBeUndefined();
  });
});

// IC-1 PR-1 (Amendment A1 §3/§4) — the in-service one-User-one-tenant guard,
// shared by BOTH User-creating write methods. Fires AFTER D5 and BEFORE any
// DB write; same-tenant → preserved 409 INVITATION_ALREADY_EXISTS; owned by
// another tenant → tenant-scoped audit (reason retained) + 409
// EMAIL_UNAVAILABLE with EXACTLY `details: {}`; a User.email P2002 lost
// between pre-check and insert maps to the same governed 409s.
const TARGET_TENANT = '01900000-0000-7000-8000-0000000000b1';
const OTHER_TENANT = '01900000-0000-7000-8000-0000000000b2';
const OWNED_USER: UserDto = {
  id: '01900000-0000-7000-8000-0000000000c1',
  email: 'owned@elsewhere.io',
  display_name: 'Owned Elsewhere',
  is_active: true,
  deactivated_at: null,
  created_at: '',
  updated_at: '',
};
const OWNED_MEMBERSHIP_IN_TARGET = {
  id: '01900000-0000-7000-8000-0000000000d1',
  user_id: OWNED_USER.id,
  tenant_id: TARGET_TENANT,
  site_id: null,
  is_active: true,
  invite_status: 'INVITED',
  joined_at: '',
  deactivated_at: null,
  created_at: '',
  updated_at: '',
};

function platformCreateArgs(email: string) {
  return {
    email,
    display_name: null,
    provider: 'cognito',
    provider_subject: 'cog-owned-1',
    tenant_id: TARGET_TENANT,
    role_keys: ['recruiter'],
    role_ids: ['role-recruiter'],
    actor_user_id: 'super-admin-1',
    request_id: REQUEST_ID,
  };
}

function tenantCreateArgs(email: string) {
  return {
    email,
    display_name: null,
    tenant_id: TARGET_TENANT,
    role_keys: ['recruiter'],
    role_ids: ['role-recruiter'],
    actor_user_id: 'tenant-admin-1',
    request_id: REQUEST_ID,
  };
}

describe('IdentityService — IC-1 PR-1 one-User-one-tenant guard (in-service, both tiers)', () => {
  it('createUserFromInvitation (platform tier): email owned by ANOTHER tenant → 409 EMAIL_UNAVAILABLE, details {}, audit reason retained, ZERO writes', async () => {
    const { identitySvc, repoSpies, auditSpies } = buildInServiceFixture(SAFE_MULTI_ROLES);
    repoSpies.findUserByEmail.mockResolvedValue(OWNED_USER);
    repoSpies.findMembership.mockResolvedValue(null);
    repoSpies.findMembershipTenantIdsForUser.mockResolvedValue([OTHER_TENANT]);

    const err = await identitySvc
      .createUserFromInvitation(platformCreateArgs('owned@elsewhere.io'))
      .then(() => null, (e: unknown) => e as { code: string; statusCode: number; context?: { details?: unknown } });
    expect(err).toMatchObject({ code: 'EMAIL_UNAVAILABLE', statusCode: 409 });
    expect(err?.context?.details).toEqual({});
    const serialized = JSON.stringify(err?.context ?? {});
    expect(serialized).not.toContain(OTHER_TENANT);
    expect(serialized).not.toContain(OWNED_USER.id);
    expect(serialized).not.toContain('owned@elsewhere.io');

    // ZERO writes, ZERO audit-on-success emissions.
    expect(repoSpies.createUserWithExternalIdentityAndMembership).not.toHaveBeenCalled();
    expect(auditSpies.writeGlobalEvent).not.toHaveBeenCalled();
    // EXACTLY one internal audit event, scoped to the ATTEMPTED target tenant,
    // retaining the actual reason + tier + caller + request id — and (Gate-5
    // G5-08) carrying NO foreign-tenant identifier anywhere in the row: the
    // subject is the attempted tenant, the payload is exactly the four
    // whitelisted keys, and neither the foreign user id, the owning tenant id
    // nor the email appears in the serialized event.
    expect(auditSpies.writeEvent).toHaveBeenCalledTimes(1);
    const evt = auditSpies.writeEvent.mock.calls[0]![0] as {
      event_type: string;
      tenant_id: string;
      actor_id: string;
      subject_id: string;
      payload: Record<string, unknown>;
    };
    expect(evt.event_type).toBe('identity.invitation.rejected_cross_tenant');
    expect(evt.tenant_id).toBe(TARGET_TENANT);
    expect(evt.actor_id).toBe('super-admin-1');
    expect(evt.subject_id).toBe(TARGET_TENANT);
    expect(evt.payload).toEqual({
      reason: 'existing_user_owned_by_other_tenant',
      tier: 'platform',
      attempted_tenant_id: TARGET_TENANT,
      request_id: REQUEST_ID,
    });
    const serializedEvent = JSON.stringify(evt);
    expect(serializedEvent).not.toContain(OWNED_USER.id);
    expect(serializedEvent).not.toContain(OTHER_TENANT);
    expect(serializedEvent).not.toContain('owned@elsewhere.io');
  });

  it('createInvitedUserNoSub (tenant tier): email owned by ANOTHER tenant → 409 EMAIL_UNAVAILABLE; no User / membership / Invitation write; tier=tenant', async () => {
    const { identitySvc, repoSpies, auditSpies } = buildInServiceFixture(SAFE_MULTI_ROLES);
    repoSpies.findUserByEmail.mockResolvedValue(OWNED_USER);
    repoSpies.findMembership.mockResolvedValue(null);
    repoSpies.findMembershipTenantIdsForUser.mockResolvedValue([OTHER_TENANT]);

    await expect(
      identitySvc.createInvitedUserNoSub(tenantCreateArgs('owned@elsewhere.io')),
    ).rejects.toMatchObject({
      code: 'EMAIL_UNAVAILABLE',
      statusCode: 409,
      context: { details: {} },
    });
    expect(repoSpies.createUserWithMembership).not.toHaveBeenCalled();
    expect(repoSpies.createInvitation).not.toHaveBeenCalled();
    expect(auditSpies.writeGlobalEvent).not.toHaveBeenCalled();
    expect(auditSpies.writeEvent).toHaveBeenCalledTimes(1);
    expect(auditSpies.writeEvent.mock.calls[0]![0]).toMatchObject({
      event_type: 'identity.invitation.rejected_cross_tenant',
      tenant_id: TARGET_TENANT,
      payload: expect.objectContaining({ tier: 'tenant' }),
    });
  });

  it('same tenant (both tiers): already a member → preserved 409 INVITATION_ALREADY_EXISTS; NEVER converted into EMAIL_UNAVAILABLE; no write, no refusal audit', async () => {
    const { identitySvc, repoSpies, auditSpies } = buildInServiceFixture(SAFE_MULTI_ROLES);
    repoSpies.findUserByEmail.mockResolvedValue(OWNED_USER);
    repoSpies.findMembership.mockResolvedValue(OWNED_MEMBERSHIP_IN_TARGET);

    await expect(
      identitySvc.createInvitedUserNoSub(tenantCreateArgs('owned@elsewhere.io')),
    ).rejects.toMatchObject({ code: 'INVITATION_ALREADY_EXISTS', statusCode: 409 });
    await expect(
      identitySvc.createUserFromInvitation(platformCreateArgs('owned@elsewhere.io')),
    ).rejects.toMatchObject({ code: 'INVITATION_ALREADY_EXISTS', statusCode: 409 });
    expect(repoSpies.createUserWithMembership).not.toHaveBeenCalled();
    expect(repoSpies.createUserWithExternalIdentityAndMembership).not.toHaveBeenCalled();
    expect(repoSpies.findMembershipTenantIdsForUser).not.toHaveBeenCalled();
    expect(auditSpies.writeEvent).not.toHaveBeenCalled();
  });

  it('normalization: the identity lookup and the stored email use trim()+toLowerCase() at both tiers', async () => {
    const { identitySvc, repoSpies } = buildInServiceFixture(SAFE_MULTI_ROLES);
    repoSpies.createUserWithMembership.mockResolvedValue({
      user: { ...OWNED_USER, id: 'u-new', email: 'new@tenant.io' },
      membership_id: 'mem-new',
      membership_role_ids: ['mr-1'],
    });
    repoSpies.createInvitation.mockResolvedValue({
      id: 'inv-1',
      user_id: 'u-new',
      tenant_id: TARGET_TENANT,
      membership_id: 'mem-new',
      token_hash: 'h',
      expires_at: '2026-12-31T00:00:00.000Z',
      accepted_at: null,
      revoked_at: null,
      created_at: '',
      updated_at: '',
    });
    await identitySvc.createInvitedUserNoSub(tenantCreateArgs('  New@Tenant.IO '));
    expect(repoSpies.findUserByEmail).toHaveBeenCalledWith('new@tenant.io');
    expect(repoSpies.createUserWithMembership).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new@tenant.io' }),
    );

    repoSpies.createUserWithExternalIdentityAndMembership.mockResolvedValue({
      user: { ...OWNED_USER, id: 'u-new2', email: 'new2@tenant.io' },
      external_identity_id: 'ext-1',
      membership_id: 'mem-new2',
      membership_role_ids: ['mr-2'],
    });
    await identitySvc.createUserFromInvitation(platformCreateArgs(' New2@Tenant.IO'));
    expect(repoSpies.findUserByEmail).toHaveBeenCalledWith('new2@tenant.io');
    expect(repoSpies.createUserWithExternalIdentityAndMembership).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new2@tenant.io' }),
    );
  });

  it('ordering: the D5 gate fires BEFORE the ownership lookup (an invertible bundle is rejected without revealing whether the email exists)', async () => {
    const { identitySvc, repoSpies } = buildInServiceFixture(INVERTIBLE_ROLES);
    repoSpies.findUserByEmail.mockResolvedValue(OWNED_USER);
    await expect(
      identitySvc.createInvitedUserNoSub({
        ...tenantCreateArgs('owned@elsewhere.io'),
        role_keys: ['pay_holder', 'spread_holder'],
        role_ids: ['role-pay_holder', 'role-spread_holder'],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(repoSpies.findUserByEmail).not.toHaveBeenCalled();
  });

  it('race backstop: a User.email P2002 raised AFTER the pre-check passed is re-probed and mapped to 409 EMAIL_UNAVAILABLE (reason email_uniqueness_race_lost) — never a raw P2002', async () => {
    const { identitySvc, repoSpies, auditSpies } = buildInServiceFixture(SAFE_MULTI_ROLES);
    // Pre-check misses (the concurrent writer has not committed yet) ...
    repoSpies.findUserByEmail
      .mockResolvedValueOnce(null)
      .mockResolvedValue(OWNED_USER);
    repoSpies.findMembership.mockResolvedValue(null);
    repoSpies.findMembershipTenantIdsForUser.mockResolvedValue([OTHER_TENANT]);
    // ... then the insert loses the unique race on User.email.
    repoSpies.createUserWithMembership.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed on the fields: (`email`)'), {
        code: 'P2002',
        meta: { target: ['email'] },
      }),
    );
    await expect(
      identitySvc.createInvitedUserNoSub(tenantCreateArgs('owned@elsewhere.io')),
    ).rejects.toMatchObject({
      code: 'EMAIL_UNAVAILABLE',
      statusCode: 409,
      context: { details: {} },
    });
    expect(repoSpies.createInvitation).not.toHaveBeenCalled();
    expect(auditSpies.writeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'identity.invitation.rejected_cross_tenant',
        payload: expect.objectContaining({ reason: 'email_uniqueness_race_lost', tier: 'tenant' }),
      }),
    );
  });

  it('race backstop: a lost race where the winner is in the SAME tenant maps to 409 INVITATION_ALREADY_EXISTS', async () => {
    const { identitySvc, repoSpies } = buildInServiceFixture(SAFE_MULTI_ROLES);
    repoSpies.findUserByEmail
      .mockResolvedValueOnce(null)
      .mockResolvedValue(OWNED_USER);
    repoSpies.findMembership.mockResolvedValue(OWNED_MEMBERSHIP_IN_TARGET);
    repoSpies.createUserWithExternalIdentityAndMembership.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: 'User_email_key' },
      }),
    );
    await expect(
      identitySvc.createUserFromInvitation(platformCreateArgs('owned@elsewhere.io')),
    ).rejects.toMatchObject({ code: 'INVITATION_ALREADY_EXISTS', statusCode: 409 });
  });

  it('race backstop: a P2002 on a DIFFERENT key is rethrown unchanged (never silently absorbed)', async () => {
    const { identitySvc, repoSpies } = buildInServiceFixture(SAFE_MULTI_ROLES);
    const foreign = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { target: ['provider', 'provider_subject'] },
    });
    repoSpies.createUserWithExternalIdentityAndMembership.mockRejectedValue(foreign);
    await expect(
      identitySvc.createUserFromInvitation(platformCreateArgs('fresh@tenant.io')),
    ).rejects.toBe(foreign);
  });

  it('isUserEmailUniqueViolation: P2002 keyed on email (field list, constraint name or target-less) matches; other keys and other codes do not', () => {
    expect(isUserEmailUniqueViolation({ code: 'P2002', meta: { target: ['email'] } })).toBe(true);
    expect(isUserEmailUniqueViolation({ code: 'P2002', meta: { target: 'User_email_key' } })).toBe(true);
    expect(isUserEmailUniqueViolation({ code: 'P2002' })).toBe(true);
    expect(isUserEmailUniqueViolation({ code: 'P2002', meta: { target: ['user_id', 'tenant_id'] } })).toBe(false);
    expect(isUserEmailUniqueViolation({ code: 'P2025' })).toBe(false);
    expect(isUserEmailUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUserEmailUniqueViolation(null)).toBe(false);
  });
});

describe('IdentityService.replaceMembershipRoles — D5 in-service safe-by-construction', () => {
  it('invertible union → VALIDATION_ERROR; ZERO reconcile write (createMany/deleteMany never reached)', async () => {
    const { identitySvc, repoSpies } = buildInServiceFixture(INVERTIBLE_ROLES);
    await expect(
      identitySvc.replaceMembershipRoles({
        membership_id: '01900000-0000-7000-8000-000000000003',
        role_keys: ['pay_holder', 'spread_holder'],
        role_ids: ['role-pay_holder', 'role-spread_holder'],
        request_id: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'invertible_role_union' } },
    });
    // The repo's reconcile primitive (the $transaction wrapper) is NEVER
    // reached — the invertible bundle is short-circuited at the service
    // boundary.
    expect(repoSpies.replaceMembershipRoles).not.toHaveBeenCalled();
  });

  it('safe multi-role union → reconcile proceeds', async () => {
    const { identitySvc, repoSpies } = buildInServiceFixture(SAFE_MULTI_ROLES);
    repoSpies.replaceMembershipRoles.mockResolvedValue({
      added_role_ids: ['role-back_office'],
      removed_role_ids: [],
    });
    const result = await identitySvc.replaceMembershipRoles({
      membership_id: '01900000-0000-7000-8000-000000000003',
      role_keys: ['recruiter', 'back_office'],
      role_ids: ['role-recruiter', 'role-back_office'],
      request_id: REQUEST_ID,
    });
    expect(result.added_role_ids).toEqual(['role-back_office']);
    expect(repoSpies.replaceMembershipRoles).toHaveBeenCalledWith({
      membership_id: '01900000-0000-7000-8000-000000000003',
      role_ids: ['role-recruiter', 'role-back_office'],
    });
  });
});
