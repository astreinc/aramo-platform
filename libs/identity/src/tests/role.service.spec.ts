import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../lib/prisma/prisma.service.js';
import { RoleRepository } from '../lib/role.repository.js';
import { RoleService } from '../lib/role.service.js';

const USER_ID = '01900000-0000-7000-8000-000000000002';
const TENANT_ID = '01900000-0000-7000-8000-000000000001';

function makePrisma(findMany: ReturnType<typeof vi.fn>): PrismaService {
  return {
    userTenantMembershipRole: { findMany },
  } as unknown as PrismaService;
}

describe('RoleService.getScopesByUserAndTenant', () => {
  // Test 6: returns deduplicated scope key strings.
  it('returns deduplicated scope key strings', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        role: {
          role_scopes: [
            { scope: { key: 'consent:read' } },
            { scope: { key: 'consent:write' } },
          ],
        },
      },
      {
        role: {
          role_scopes: [
            { scope: { key: 'consent:read' } }, // duplicate
            { scope: { key: 'auth:session:read' } },
          ],
        },
      },
    ]);
    const service = new RoleService(new RoleRepository(makePrisma(findMany)));

    const result = await service.getScopesByUserAndTenant({
      user_id: USER_ID,
      tenant_id: TENANT_ID,
    });

    const sorted = [...result].sort();
    expect(sorted).toEqual(['auth:session:read', 'consent:read', 'consent:write']);
    expect(result).toHaveLength(3);
  });

  // Test 7: returns empty array when no active membership in tenant.
  it('returns empty array when no active membership in tenant', async () => {
    // Repository filters DB-side on membership.is_active=true; when no
    // matching membership-role rows are found, findMany returns [].
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new RoleService(new RoleRepository(makePrisma(findMany)));

    const result = await service.getScopesByUserAndTenant({
      user_id: USER_ID,
      tenant_id: TENANT_ID,
    });

    expect(result).toEqual([]);
  });

  // Test 8: filters by active role assignments only.
  it('filters by active role assignments only', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new RoleService(new RoleRepository(makePrisma(findMany)));

    await service.getScopesByUserAndTenant({ user_id: USER_ID, tenant_id: TENANT_ID });

    const calledWith = findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    const roleClause = calledWith.where['role'] as { is_active: boolean };
    const membershipClause = calledWith.where['membership'] as {
      is_active: boolean;
      user_id: string;
      tenant_id: string;
    };
    expect(roleClause.is_active).toBe(true);
    expect(membershipClause.is_active).toBe(true);
    expect(membershipClause.user_id).toBe(USER_ID);
    expect(membershipClause.tenant_id).toBe(TENANT_ID);
  });

  // Test 9 (service portion): primitive string[], not Prisma models.
  it('returns primitive string[] (test 9)', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        role: {
          role_scopes: [{ scope: { key: 'consent:read' } }],
        },
      },
    ]);
    const service = new RoleService(new RoleRepository(makePrisma(findMany)));

    const result = await service.getScopesByUserAndTenant({
      user_id: USER_ID,
      tenant_id: TENANT_ID,
    });

    expect(Array.isArray(result)).toBe(true);
    for (const key of result) {
      expect(typeof key).toBe('string');
    }
  });
});
