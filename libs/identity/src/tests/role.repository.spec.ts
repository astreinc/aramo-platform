import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../lib/prisma/prisma.service.js';
import { RoleRepository } from '../lib/role.repository.js';

const USER_ID = '01900000-0000-7000-8000-000000000002';
const TENANT_ID = '01900000-0000-7000-8000-000000000001';

// Sign Feature-Parity §1.21 — the repository also reads custom Sign role assignments
// (none unless a test passes them).
function makePrisma(findMany: ReturnType<typeof vi.fn>, customFindMany: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue([])): PrismaService {
  return {
    userTenantMembershipRole: { findMany },
    signCustomRoleAssignment: { findMany: customFindMany },
  } as unknown as PrismaService;
}

describe('RoleRepository.findScopeKeysForUserInTenant', () => {
  it('passes active-membership + active-role filters (test 7 + test 8 supporting)', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new RoleRepository(makePrisma(findMany));

    await repo.findScopeKeysForUserInTenant({ user_id: USER_ID, tenant_id: TENANT_ID });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        membership: {
          user_id: USER_ID,
          tenant_id: TENANT_ID,
          is_active: true,
        },
        role: { is_active: true },
      },
      include: {
        role: {
          include: {
            role_scopes: { include: { scope: true } },
          },
        },
      },
    });
  });

  it('returns deduplicated scope keys when multiple roles grant the same scope (test 6)', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'utr-1',
        membership_id: 'm-1',
        role_id: 'r-1',
        role: {
          role_scopes: [
            { scope: { key: 'consent:read' } },
            { scope: { key: 'consent:write' } },
          ],
        },
      },
      {
        id: 'utr-2',
        membership_id: 'm-1',
        role_id: 'r-2',
        role: {
          // Overlapping scope: consent:read should appear once in output.
          role_scopes: [
            { scope: { key: 'consent:read' } },
            { scope: { key: 'auth:session:read' } },
          ],
        },
      },
    ]);
    const repo = new RoleRepository(makePrisma(findMany));

    const result = await repo.findScopeKeysForUserInTenant({
      user_id: USER_ID,
      tenant_id: TENANT_ID,
    });

    const sorted = [...result].sort();
    expect(sorted).toEqual(['auth:session:read', 'consent:read', 'consent:write']);
    // Verify it's actually deduplicated (length 3, not 4).
    expect(result).toHaveLength(3);
  });

  it('returns empty array when no role assignments exist (test 7)', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new RoleRepository(makePrisma(findMany));

    const result = await repo.findScopeKeysForUserInTenant({
      user_id: USER_ID,
      tenant_id: TENANT_ID,
    });

    expect(result).toEqual([]);
  });

  it('output is an array of primitive strings, not Prisma models (test 9)', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        role: {
          role_scopes: [{ scope: { key: 'consent:read' } }],
        },
      },
    ]);
    const repo = new RoleRepository(makePrisma(findMany));

    const result = await repo.findScopeKeysForUserInTenant({
      user_id: USER_ID,
      tenant_id: TENANT_ID,
    });

    expect(Array.isArray(result)).toBe(true);
    for (const key of result) {
      expect(typeof key).toBe('string');
    }
  });
});

// Aramo Sign Feature-Parity §1.21 — custom Sign role scopes are a SEPARATE read (only `sign`
// consumer resolution unions them): for ONE tenant (assignment, role and membership all
// filtered on it), live roles on active memberships only, the site rule of the site-aware
// reader, and only composable Sign scopes. The built-in readers never touch the new table.
describe('RoleRepository — custom Sign role scopes', () => {
  it('the built-in readers do not read custom roles (ATS/org/platform scope sets unchanged)', async () => {
    const custom = vi.fn().mockResolvedValue([{ role: { scope_keys: ['sign:envelope:send'] } }]);
    const builtIn = vi.fn().mockResolvedValue([{ role: { role_scopes: [{ scope: { key: 'talent:read' } }] } }]);
    const repo = new RoleRepository(makePrisma(builtIn, custom));
    expect(await repo.findScopeKeysForUserInTenant({ user_id: USER_ID, tenant_id: TENANT_ID })).toEqual(['talent:read']);
    expect(await repo.findScopeKeysForUserInTenantAndSite({ user_id: USER_ID, tenant_id: TENANT_ID })).toEqual(['talent:read']);
    expect(custom).not.toHaveBeenCalled();
  });

  it('reads with tenant-scoped filters and the tenant-wide site rule', async () => {
    const custom = vi.fn().mockResolvedValue([
      { role: { scope_keys: ['sign:envelope:send', 'sign:envelope:read'] } },
      { role: { scope_keys: ['sign:report:read', 'sign:envelope:read'] } },
    ]);
    const repo = new RoleRepository(makePrisma(vi.fn(), custom));
    expect(await repo.findSignCustomRoleScopeKeys({ user_id: USER_ID, tenant_id: TENANT_ID })).toEqual(['sign:envelope:read', 'sign:envelope:send', 'sign:report:read']);
    expect(custom).toHaveBeenCalledWith({
      where: {
        tenant_id: TENANT_ID,
        membership: { user_id: USER_ID, tenant_id: TENANT_ID, is_active: true, site_id: null },
        role: { tenant_id: TENANT_ID, deleted_at: null },
      },
      select: { role: { select: { scope_keys: true } } },
    });
  });

  it('a site-scoped token reads tenant-wide plus that site', async () => {
    const custom = vi.fn().mockResolvedValue([]);
    const repo = new RoleRepository(makePrisma(vi.fn(), custom));
    await repo.findSignCustomRoleScopeKeys({ user_id: USER_ID, tenant_id: TENANT_ID, site_id: 'site-x' });
    expect(custom.mock.calls[0]![0].where.membership).toEqual({ user_id: USER_ID, tenant_id: TENANT_ID, is_active: true, OR: [{ site_id: null }, { site_id: 'site-x' }] });
  });

  it('a tampered custom role row can never contribute billing, platform, ATS or unknown scopes', async () => {
    const custom = vi.fn().mockResolvedValue([
      { role: { scope_keys: ['sign:billing:manage', 'platform:tenant:read', 'talent:read', 'sign:*', 'sign:contact:read'] } },
    ]);
    const repo = new RoleRepository(makePrisma(vi.fn(), custom));
    expect(await repo.findSignCustomRoleScopeKeys({ user_id: USER_ID, tenant_id: TENANT_ID })).toEqual(['sign:contact:read']);
  });
});
