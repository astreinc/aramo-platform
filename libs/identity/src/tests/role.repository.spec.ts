import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../lib/prisma/prisma.service.js';
import { RoleRepository } from '../lib/role.repository.js';

const USER_ID = '01900000-0000-7000-8000-000000000002';
const TENANT_ID = '01900000-0000-7000-8000-000000000001';

function makePrisma(findMany: ReturnType<typeof vi.fn>): PrismaService {
  return {
    userTenantMembershipRole: { findMany },
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
