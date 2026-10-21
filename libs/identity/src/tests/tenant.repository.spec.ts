import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../lib/prisma/prisma.service.js';
import { TenantRepository } from '../lib/tenant.repository.js';

const USER_ID = '01900000-0000-7000-8000-000000000002';
const TENANT_A = '01900000-0000-7000-8000-000000000001';

function makePrisma(findMany: ReturnType<typeof vi.fn>): PrismaService {
  return { tenant: { findMany } } as unknown as PrismaService;
}

describe('TenantRepository.findActiveTenantsForUser', () => {
  it('passes active-membership + active-tenant filter to the query (test 4 supporting)', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new TenantRepository(makePrisma(findMany));

    await repo.findActiveTenantsForUser({ user_id: USER_ID });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        is_active: true,
        memberships: {
          some: {
            user_id: USER_ID,
            is_active: true,
          },
        },
      },
      orderBy: { created_at: 'asc' },
    });
  });

  it('maps each row through toTenantDto (ISO-string timestamps, no Prisma model leakage)', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: TENANT_A,
        name: 'Aramo Dev Tenant',
        is_active: true,
        created_at: new Date('2026-05-12T00:00:00Z'),
        updated_at: new Date('2026-05-12T00:00:00Z'),
      },
    ]);
    const repo = new TenantRepository(makePrisma(findMany));

    const result = await repo.findActiveTenantsForUser({ user_id: USER_ID });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(TENANT_A);
    expect(result[0]?.name).toBe('Aramo Dev Tenant');
    expect(result[0]?.is_active).toBe(true);
    expect(typeof result[0]?.created_at).toBe('string');
    expect(typeof result[0]?.updated_at).toBe('string');
  });

  it('returns empty array when user has no memberships (test 5 supporting)', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new TenantRepository(makePrisma(findMany));

    const result = await repo.findActiveTenantsForUser({ user_id: USER_ID });

    expect(result).toEqual([]);
  });
});

// DOC-TEMPLATE-LIB-1 T-3 (§4.3) — the branding read also selects the tenant-profile address
// columns (the organization.address_* template variables), read-only, by id.
describe('TenantRepository.findBrandingById', () => {
  it('selects names + logo + the address columns by id', async () => {
    const row = {
      name: 'acme-ws',
      display_name: 'Acme',
      legal_name: 'Acme LLC',
      logo_url: null,
      address_line1: '1 Main St',
      address_line2: null,
      city: 'Iselin',
      state_province: 'NJ',
      postal_code: '08830',
      country_code: 'US',
    };
    const findUnique = vi.fn().mockResolvedValue(row);
    const repo = new TenantRepository({ tenant: { findUnique } } as unknown as PrismaService);

    expect(await repo.findBrandingById(TENANT_A)).toEqual(row);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: TENANT_A },
      select: {
        name: true,
        display_name: true,
        legal_name: true,
        logo_url: true,
        address_line1: true,
        address_line2: true,
        city: true,
        state_province: true,
        postal_code: true,
        country_code: true,
      },
    });
  });
});
