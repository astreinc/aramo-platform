import { describe, expect, it, vi } from 'vitest';

import { IdentityAuditService } from '../lib/audit/identity-audit.service.js';
import { IdentityRepository } from '../lib/identity.repository.js';
import { IdentityService } from '../lib/identity.service.js';
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
    createMembershipForExistingUser: ReturnType<typeof vi.fn>;
    replaceMembershipRoles: ReturnType<typeof vi.fn>;
    findMembership: ReturnType<typeof vi.fn>;
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
    createMembershipForExistingUser: vi.fn(),
    replaceMembershipRoles: vi.fn(),
    findMembership: vi.fn(),
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

describe('IdentityService.addMembershipForExistingUser — D5 in-service safe-by-construction', () => {
  it('invertible union → VALIDATION_ERROR; ZERO DB writes; ZERO audit emissions; existence check NEVER reached', async () => {
    const { identitySvc, repoSpies, auditSpies } = buildInServiceFixture(
      INVERTIBLE_ROLES,
    );
    await expect(
      identitySvc.addMembershipForExistingUser({
        user_id: '01900000-0000-7000-8000-000000000002',
        tenant_id: '01900000-0000-7000-8000-000000000001',
        role_keys: ['pay_holder', 'spread_holder'],
        role_ids: ['role-pay_holder', 'role-spread_holder'],
        actor_user_id: 'super-admin-1',
        request_id: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'invertible_role_union' } },
    });
    // Validator fires BEFORE findMembership (no membership-existence leak)
    // and BEFORE createMembershipForExistingUser.
    expect(repoSpies.findMembership).not.toHaveBeenCalled();
    expect(repoSpies.createMembershipForExistingUser).not.toHaveBeenCalled();
    expect(auditSpies.writeEvent).not.toHaveBeenCalled();
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
