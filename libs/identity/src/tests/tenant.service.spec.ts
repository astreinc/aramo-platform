import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../lib/prisma/prisma.service.js';
import { TenantRepository } from '../lib/tenant.repository.js';
import { TenantService } from '../lib/tenant.service.js';
import type { TenantDto } from '../lib/dto/tenant.dto.js';

const USER_ID = '01900000-0000-7000-8000-000000000002';
const TENANT_A = '01900000-0000-7000-8000-000000000001';
const TENANT_B = '01900000-0000-7000-8000-0000000000a1';

function makePrisma(findMany: ReturnType<typeof vi.fn>): PrismaService {
  return { tenant: { findMany } } as unknown as PrismaService;
}

describe('TenantService.getTenantsByUser', () => {
  // Test 4: returns only active memberships and active tenants.
  // Filter happens DB-side; the spec verifies the where-clause shape and
  // that returned rows pass through unfiltered. The TenantRepository's
  // findMany call (verified in tenant.repository.spec.ts) carries
  // is_active=true on both Tenant and Membership; this spec re-asserts the
  // behavior at the service boundary.
  it('returns only active memberships and active tenants', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: TENANT_A,
        name: 'Aramo Dev Tenant',
        is_active: true,
        created_at: new Date('2026-05-12T00:00:00Z'),
        updated_at: new Date('2026-05-12T00:00:00Z'),
      },
      {
        id: TENANT_B,
        name: 'Another Active Tenant',
        is_active: true,
        created_at: new Date('2026-05-12T01:00:00Z'),
        updated_at: new Date('2026-05-12T01:00:00Z'),
      },
    ]);
    const service = new TenantService(new TenantRepository(makePrisma(findMany)));

    const result = await service.getTenantsByUser({ user_id: USER_ID });

    expect(result).toHaveLength(2);
    expect(result.every((t) => t.is_active)).toBe(true);
    // Verify the filter was applied at the query level.
    const calledWith = findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(calledWith.where['is_active']).toBe(true);
    expect(calledWith.where['memberships']).toMatchObject({
      some: { user_id: USER_ID, is_active: true },
    });
  });

  // Test 5: returns empty array when user has no memberships.
  it('returns empty array when user has no memberships', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new TenantService(new TenantRepository(makePrisma(findMany)));

    const result = await service.getTenantsByUser({ user_id: USER_ID });

    expect(result).toEqual([]);
  });

  // Test 9 (service portion): returns DTO array, no Prisma model leakage.
  it('returns TenantDto[] with ISO-string timestamps', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: TENANT_A,
        name: 'Aramo Dev Tenant',
        is_active: true,
        created_at: new Date('2026-05-12T00:00:00Z'),
        updated_at: new Date('2026-05-12T00:00:00Z'),
      },
    ]);
    const service = new TenantService(new TenantRepository(makePrisma(findMany)));

    const result = (await service.getTenantsByUser({ user_id: USER_ID })) satisfies TenantDto[];

    for (const t of result) {
      expect(typeof t.created_at).toBe('string');
      expect(typeof t.updated_at).toBe('string');
      expect(t).not.toHaveProperty('memberships');
    }
  });
});
