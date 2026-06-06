import { describe, expect, it, vi } from 'vitest';

import { IdentityRepository } from '../lib/identity.repository.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

const USER_ID = '01900000-0000-7000-8000-000000000002';
const COGNITO_SUB = 'fixed-dev-cognito-sub-01';

function makePrisma(externalIdentityFindUnique: ReturnType<typeof vi.fn>): PrismaService {
  return {
    externalIdentity: { findUnique: externalIdentityFindUnique },
  } as unknown as PrismaService;
}

describe('IdentityRepository.findUserByExternalIdentity', () => {
  it('returns a UserDto when ExternalIdentity exists (test 1 supporting)', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: '01900000-0000-7000-8000-000000000004',
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
    const repo = new IdentityRepository(makePrisma(findUnique));

    const result = await repo.findUserByExternalIdentity({
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
    });

    expect(result).not.toBeNull();
    expect(result?.id).toBe(USER_ID);
    expect(result?.email).toBe('admin@aramo.dev');
    expect(result?.is_active).toBe(true);
    expect(result?.deactivated_at).toBeNull();
    // Created_at serializes as ISO string at the public boundary.
    expect(typeof result?.created_at).toBe('string');
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        provider_provider_subject: {
          provider: 'cognito',
          provider_subject: COGNITO_SUB,
        },
      },
      include: { user: true },
    });
  });

  it('returns null when no ExternalIdentity mapping exists (test 2 supporting)', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const repo = new IdentityRepository(makePrisma(findUnique));

    const result = await repo.findUserByExternalIdentity({
      provider: 'cognito',
      provider_subject: 'unknown-sub',
    });

    expect(result).toBeNull();
  });

  it('serializes deactivated_at when User.deactivated_at is set', async () => {
    const deactivatedAt = new Date('2026-05-10T00:00:00Z');
    const findUnique = vi.fn().mockResolvedValue({
      id: 'ext-id',
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
      user_id: USER_ID,
      email_snapshot: null,
      created_at: new Date(),
      updated_at: new Date(),
      user: {
        id: USER_ID,
        email: 'inactive@aramo.dev',
        display_name: null,
        is_active: false,
        deactivated_at: deactivatedAt,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
    const repo = new IdentityRepository(makePrisma(findUnique));

    const result = await repo.findUserByExternalIdentity({
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
    });

    expect(result?.is_active).toBe(false);
    expect(result?.deactivated_at).toBe(deactivatedAt.toISOString());
  });
});

describe('IdentityRepository.findExternalIdentity', () => {
  it('returns ExternalIdentityDto when mapping exists', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: '01900000-0000-7000-8000-000000000004',
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
      user_id: USER_ID,
      email_snapshot: 'admin@aramo.dev',
      created_at: new Date('2026-05-12T00:00:00Z'),
      updated_at: new Date('2026-05-12T00:00:00Z'),
    });
    const repo = new IdentityRepository(makePrisma(findUnique));

    const result = await repo.findExternalIdentity({
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
    });

    expect(result?.user_id).toBe(USER_ID);
    expect(result?.provider).toBe('cognito');
    expect(typeof result?.created_at).toBe('string');
  });
});

// Settings S5-BE1 — tenant-users reads (the S5b prereq).
//
// Repo-layer proofs that complement the controller-spec Cat-5 set:
//   - listTenantUsers scopes the WHERE clause to tenant_id ONLY (the
//     per-tenant isolation invariant lives in this WHERE; if it ever
//     widens, the controller's authContext-scoped invariant breaks)
//   - listTenantUsers serializes the row shape (membership-level
//     is_active + deactivated_at, NOT User-level; site_id surfaces;
//     role_keys sorted asc; only active roles)
//   - getTenantUser uses the composite (user_id, tenant_id) unique index
//     so a cross-tenant user_id can't leak a tenant-B row through; null
//     when no membership

const TENANT_ID = '01900000-0000-7000-8000-000000000001';
const OTHER_TENANT_ID = '01900000-0000-7000-8000-0000000000ee';
const SITE_ID = '01900000-0000-7000-8000-000000000099';

function makePrismaForMembership(fns: {
  findMany?: ReturnType<typeof vi.fn>;
  findUnique?: ReturnType<typeof vi.fn>;
}): PrismaService {
  return {
    userTenantMembership: {
      findMany: fns.findMany ?? vi.fn(),
      findUnique: fns.findUnique ?? vi.fn(),
    },
  } as unknown as PrismaService;
}

describe('IdentityRepository.listTenantUsers — Settings S5-BE1', () => {
  it('WHERE clause filters on tenant_id ONLY (per-tenant isolation invariant)', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new IdentityRepository(
      makePrismaForMembership({ findMany }),
    );

    await repo.listTenantUsers(TENANT_ID);

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]?.[0] as {
      where: { tenant_id: string };
      include: unknown;
      orderBy: unknown;
    };
    // The WHERE is tenant_id, and ONLY tenant_id (no other-tenant value
    // anywhere in the query). A passing read for tenant A cannot return
    // a tenant-B row.
    expect(args.where).toEqual({ tenant_id: TENANT_ID });
    expect(args.where).not.toMatchObject({ tenant_id: OTHER_TENANT_ID });
    // Include shape: user + role_assignments → role.key
    expect(args.include).toMatchObject({
      user: true,
      role_assignments: {
        where: { role: { is_active: true } },
        include: { role: { select: { key: true } } },
      },
    });
    // Stable order (joined_at asc, user_id asc) — the UI-friendly default.
    expect(args.orderBy).toEqual([
      { joined_at: 'asc' },
      { user_id: 'asc' },
    ]);
  });

  it('serializes row shape: membership-level state + site_id + sorted role_keys (active roles only)', async () => {
    const deactivatedAt = new Date('2026-06-01T12:00:00Z');
    const findMany = vi.fn().mockResolvedValue([
      {
        user_id: '01900000-0000-7000-8000-0000000000aa',
        tenant_id: TENANT_ID,
        site_id: null,
        is_active: true,
        deactivated_at: null,
        user: { email: 'alice@example.com', display_name: 'Alice' },
        role_assignments: [
          { role: { key: 'recruiter' } },
          { role: { key: 'account_manager' } },
        ],
      },
      {
        user_id: '01900000-0000-7000-8000-0000000000bb',
        tenant_id: TENANT_ID,
        site_id: SITE_ID,
        is_active: false,
        deactivated_at: deactivatedAt,
        user: { email: 'bob@example.com', display_name: null },
        role_assignments: [{ role: { key: 'sourcer' } }],
      },
    ]);
    const repo = new IdentityRepository(
      makePrismaForMembership({ findMany }),
    );

    const result = await repo.listTenantUsers(TENANT_ID);

    expect(result).toHaveLength(2);
    // (d) role_keys sorted asc
    expect(result[0]?.role_keys).toEqual(['account_manager', 'recruiter']);
    // (c) the disabled user's membership-level state surfaces (S3a saga
    // writes UserTenantMembership.is_active + deactivated_at; we
    // serialize the membership row's fields, NOT User.is_active).
    expect(result[1]?.is_active).toBe(false);
    expect(result[1]?.deactivated_at).toBe(deactivatedAt.toISOString());
    expect(result[1]?.display_name).toBeNull();
    // site_id surfaces (nullable; bob is site-scoped, alice is not)
    expect(result[0]?.site_id).toBeNull();
    expect(result[1]?.site_id).toBe(SITE_ID);
  });
});

describe('IdentityRepository.getTenantUser — Settings S5-BE1', () => {
  it('uses the composite (user_id, tenant_id) unique key — cross-tenant user_id can\'t leak', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const repo = new IdentityRepository(
      makePrismaForMembership({ findUnique }),
    );

    const result = await repo.getTenantUser({
      user_id: '01900000-0000-7000-8000-0000000000aa',
      tenant_id: TENANT_ID,
    });

    expect(result).toBeNull();
    const args = findUnique.mock.calls[0]?.[0] as {
      where: { user_id_tenant_id: { user_id: string; tenant_id: string } };
    };
    expect(args.where).toEqual({
      user_id_tenant_id: {
        user_id: '01900000-0000-7000-8000-0000000000aa',
        tenant_id: TENANT_ID,
      },
    });
    // The cross-tenant value is NEVER in the WHERE — even if a hostile
    // caller smuggled a tenant_id through the controller (which they
    // can't — the controller forces authContext.tenant_id), the repo
    // layer would receive only this tenant's composite key.
    expect(JSON.stringify(args.where)).not.toContain(OTHER_TENANT_ID);
  });

  it('returns the TenantUserView when the membership exists in this tenant', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      user_id: '01900000-0000-7000-8000-0000000000aa',
      tenant_id: TENANT_ID,
      site_id: null,
      is_active: true,
      deactivated_at: null,
      user: { email: 'alice@example.com', display_name: 'Alice' },
      role_assignments: [{ role: { key: 'recruiter' } }],
    });
    const repo = new IdentityRepository(
      makePrismaForMembership({ findUnique }),
    );

    const result = await repo.getTenantUser({
      user_id: '01900000-0000-7000-8000-0000000000aa',
      tenant_id: TENANT_ID,
    });

    expect(result).toEqual({
      user_id: '01900000-0000-7000-8000-0000000000aa',
      email: 'alice@example.com',
      display_name: 'Alice',
      is_active: true,
      deactivated_at: null,
      site_id: null,
      role_keys: ['recruiter'],
    });
  });
});
