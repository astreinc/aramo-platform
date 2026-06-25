import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../lib/prisma/prisma.service.js';
import type { IdentityAuditService } from '../lib/audit/identity-audit.service.js';
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

// Domain-Enforcement P1 — the SERVICE-LAYER reject-personal invariant (§2).
// provisionTenant derives the owner's domain, rejects a personal/disposable
// provider, and persists the surviving (business) domain as the tenant's
// locked allowed_domain. Because the invariant lives in the service method
// (not the platform-admin controller), EVERY future creation path inherits it.
describe('TenantService.provisionTenant — Domain-Enforcement P1', () => {
  const ACTOR_ID = '01900000-0000-7000-8000-0000000000aa';

  function makeService(createdName = 'Acme'): {
    service: TenantService;
    createTenant: ReturnType<typeof vi.fn>;
    writeEvent: ReturnType<typeof vi.fn>;
  } {
    const createTenant = vi.fn().mockResolvedValue({
      id: TENANT_A,
      name: createdName,
      is_active: true,
      created_at: '2026-06-25T00:00:00.000Z',
      updated_at: '2026-06-25T00:00:00.000Z',
    } satisfies TenantDto);
    const repo = {
      findByNameCaseInsensitive: vi.fn().mockResolvedValue(null),
      createTenant,
    } as unknown as TenantRepository;
    const writeEvent = vi.fn().mockResolvedValue(undefined);
    const audit = { writeEvent } as unknown as IdentityAuditService;
    return { service: new TenantService(repo, audit), createTenant, writeEvent };
  }

  it('PERSONAL owner email (gmail) → VALIDATION_ERROR personal_email_not_allowed; tenant NOT created', async () => {
    const { service, createTenant } = makeService();
    await expect(
      service.provisionTenant({
        name: 'Acme',
        owner_email: 'founder@gmail.com',
        actor_user_id: ACTOR_ID,
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      context: { details: { reason: 'personal_email_not_allowed', domain: 'gmail.com' } },
    });
    expect(createTenant).not.toHaveBeenCalled();
  });

  it('DISPOSABLE owner email (mailinator) → VALIDATION_ERROR personal_email_not_allowed; tenant NOT created', async () => {
    const { service, createTenant } = makeService();
    await expect(
      service.provisionTenant({
        name: 'Acme',
        owner_email: 'throwaway@mailinator.com',
        actor_user_id: ACTOR_ID,
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'personal_email_not_allowed' } },
    });
    expect(createTenant).not.toHaveBeenCalled();
  });

  it('malformed owner email (no domain) → VALIDATION_ERROR invalid_owner_email', async () => {
    const { service, createTenant } = makeService();
    await expect(
      service.provisionTenant({
        name: 'Acme',
        owner_email: 'not-an-email',
        actor_user_id: ACTOR_ID,
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'invalid_owner_email' } },
    });
    expect(createTenant).not.toHaveBeenCalled();
  });

  it('BUSINESS owner email → tenant created with allowed_domain set + audit carries it', async () => {
    const { service, createTenant, writeEvent } = makeService();
    await service.provisionTenant({
      name: 'Acme',
      // Mixed-case to prove the persisted domain is normalized (lowercased).
      owner_email: 'Owner@Astreinc.com',
      actor_user_id: ACTOR_ID,
    });
    expect(createTenant).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Acme', allowed_domain: 'astreinc.com' }),
    );
    expect(writeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'identity.tenant.created',
        payload: expect.objectContaining({ allowed_domain: 'astreinc.com' }),
      }),
    );
  });
});
