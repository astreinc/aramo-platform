import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../lib/prisma/prisma.service.js';
import type { IdentityAuditService } from '../lib/audit/identity-audit.service.js';
import { TenantRepository } from '../lib/tenant.repository.js';
import { TenantService } from '../lib/tenant.service.js';
import type { DomainClaimService } from '../lib/domain-claim/domain-claim.service.js';
import type { TenantDto } from '../lib/dto/tenant.dto.js';

const USER_ID = '01900000-0000-7000-8000-000000000002';
const TENANT_A = '01900000-0000-7000-8000-000000000001';
const TENANT_B = '01900000-0000-7000-8000-0000000000a1';

// Domain-Enforcement P3 — a domain-claim double: nothing held; the claim is a no-op.
function makeDomainClaims(held = false) {
  return {
    isDomainHeld: vi.fn().mockResolvedValue(held),
    claimForNewTenant: vi.fn().mockResolvedValue(undefined),
    lapse: vi.fn().mockResolvedValue(undefined),
  };
}
const TX = { __tx: true };

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
      withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(TX)),
    } as unknown as TenantRepository;
    const writeEvent = vi.fn().mockResolvedValue(undefined);
    const audit = { writeEvent } as unknown as IdentityAuditService;
    return { service: new TenantService(repo, audit, makeDomainClaims() as unknown as DomainClaimService), createTenant, writeEvent };
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
    // P3 — a BUSINESS insert runs inside the domain-claim transaction (2nd arg).
    expect(createTenant).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Acme', allowed_domain: 'astreinc.com' }),
      TX,
    );
    expect(writeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'identity.tenant.created',
        payload: expect.objectContaining({ allowed_domain: 'astreinc.com' }),
      }),
    );
  });
});

// IC-4 PR-9 (IC-0 §H; Domain-Enforcement P1 Amendment P1-A1) — the PERSONAL
// kind: no locked domain, the personal-provider rejection does not apply, the
// kind is persisted and recorded on the birth event; BUSINESS stays byte-
// identical (kind BUSINESS, domain derived). Unknown kinds fail closed.
describe('TenantService.provisionTenant — IC-4 PR-9 tenant kind', () => {
  const ACTOR_ID = '01900000-0000-7000-8000-0000000000aa';
  function makeService(): { service: TenantService; createTenant: ReturnType<typeof vi.fn>; writeEvent: ReturnType<typeof vi.fn> } {
    const createTenant = vi.fn().mockResolvedValue({
      id: TENANT_A, name: 'Jane Doe', is_active: true, created_at: '2026-10-14T00:00:00.000Z', updated_at: '2026-10-14T00:00:00.000Z',
      identity_provider: null, status: 'PROVISIONED', kind: 'PERSONAL',
    } satisfies TenantDto);
    const repo = {
      findByNameCaseInsensitive: vi.fn().mockResolvedValue(null),
      createTenant,
      withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(TX)),
    } as unknown as TenantRepository;
    const writeEvent = vi.fn().mockResolvedValue(undefined);
    return { service: new TenantService(repo, { writeEvent } as unknown as IdentityAuditService, makeDomainClaims() as unknown as DomainClaimService), createTenant, writeEvent };
  }
  it('PERSONAL + personal-provider owner email → created with allowed_domain NULL, kind PERSONAL; the birth event records kind', async () => {
    const { service, createTenant, writeEvent } = makeService();
    await service.provisionTenant({ name: 'Jane Doe', owner_email: 'Jane.Doe@gmail.com', actor_user_id: ACTOR_ID, kind: 'PERSONAL' });
    expect(createTenant).toHaveBeenCalledWith(expect.objectContaining({ name: 'Jane Doe', allowed_domain: null, kind: 'PERSONAL' }));
    expect(writeEvent).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'identity.tenant.created',
      payload: expect.objectContaining({ allowed_domain: null, kind: 'PERSONAL' }),
    }));
  });
  it('PERSONAL + disposable-provider owner email → also accepted (the P1 rejection is a BUSINESS rule)', async () => {
    const { service, createTenant } = makeService();
    await service.provisionTenant({ name: 'Temp Person', owner_email: 'someone@mailinator.com', actor_user_id: ACTOR_ID, kind: 'PERSONAL' });
    expect(createTenant).toHaveBeenCalledWith(expect.objectContaining({ allowed_domain: null, kind: 'PERSONAL' }));
  });
  it('PERSONAL + malformed owner email → VALIDATION_ERROR invalid_owner_email; tenant NOT created', async () => {
    const { service, createTenant } = makeService();
    await expect(service.provisionTenant({ name: 'Nobody', owner_email: 'nobody-at-nowhere', actor_user_id: ACTOR_ID, kind: 'PERSONAL' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400, context: { details: { reason: 'invalid_owner_email' } } });
    expect(createTenant).not.toHaveBeenCalled();
  });
  it('unknown kind → VALIDATION_ERROR invalid_tenant_kind before any lookup or write', async () => {
    const { service, createTenant } = makeService();
    await expect(service.provisionTenant({ name: 'X', owner_email: 'owner@astreinc.com', actor_user_id: ACTOR_ID, kind: 'ENTERPRISE' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400, context: { details: { reason: 'invalid_tenant_kind', kind: 'ENTERPRISE' } } });
    expect(createTenant).not.toHaveBeenCalled();
  });
  it('BUSINESS (default when omitted) is unchanged: personal-provider owner refused, business owner domain locked, kind BUSINESS persisted', async () => {
    const { service, createTenant, writeEvent } = makeService();
    await expect(service.provisionTenant({ name: 'Acme', owner_email: 'founder@gmail.com', actor_user_id: ACTOR_ID }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { reason: 'personal_email_not_allowed' } } });
    await service.provisionTenant({ name: 'Acme', owner_email: 'Owner@Astreinc.com', actor_user_id: ACTOR_ID });
    expect(createTenant).toHaveBeenCalledWith(expect.objectContaining({ allowed_domain: 'astreinc.com', kind: 'BUSINESS' }), TX);
    expect(writeEvent).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ allowed_domain: 'astreinc.com', kind: 'BUSINESS' }) }));
  });
});

// Domain-Enforcement P3 (LOCKED) §3/§7 (unit) — one organization per email domain
// at the authoritative provisioning spine: check order (name → domain), the tenant
// insert and the PROVISIONAL claim share ONE transaction, PERSONAL is untouched,
// and a soft-disable lapses the claim.
describe('TenantService.provisionTenant — Domain-Enforcement P3', () => {
  const ACTOR_ID = '01900000-0000-7000-8000-0000000000aa';
  function make(opts: { nameTaken?: boolean; held?: boolean } = {}) {
    const createTenant = vi.fn().mockResolvedValue({
      id: TENANT_A, name: 'Acme', is_active: true, created_at: '2026-10-21T00:00:00.000Z', updated_at: '2026-10-21T00:00:00.000Z',
    });
    const withTransaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(TX));
    const deactivateTenant = vi.fn().mockResolvedValue(undefined);
    const repo = {
      findByNameCaseInsensitive: vi.fn().mockResolvedValue(opts.nameTaken === true ? { id: TENANT_B, name: 'Acme' } : null),
      createTenant,
      withTransaction,
      deactivateTenant,
    } as unknown as TenantRepository;
    const domainClaims = makeDomainClaims(opts.held === true);
    const writeEvent = vi.fn().mockResolvedValue(undefined);
    const service = new TenantService(repo, { writeEvent } as unknown as IdentityAuditService, domainClaims as unknown as DomainClaimService);
    return { service, createTenant, withTransaction, domainClaims, deactivateTenant };
  }

  it('name is checked before the domain (a taken name never reaches the domain check)', async () => {
    const { service, domainClaims, createTenant } = make({ nameTaken: true, held: true });
    await expect(service.provisionTenant({ name: 'Acme', owner_email: 'o@acme.io', actor_user_id: ACTOR_ID }))
      .rejects.toMatchObject({ code: 'TENANT_ALREADY_EXISTS' });
    expect(domainClaims.isDomainHeld).not.toHaveBeenCalled();
    expect(createTenant).not.toHaveBeenCalled();
  });

  it('a held domain → 409 TENANT_DOMAIN_UNAVAILABLE (organization_domain_taken); nothing is written', async () => {
    const { service, domainClaims, createTenant, withTransaction } = make({ held: true });
    await expect(service.provisionTenant({ name: 'Acme', owner_email: 'o@Acme.io', actor_user_id: ACTOR_ID }))
      .rejects.toMatchObject({ code: 'TENANT_DOMAIN_UNAVAILABLE', statusCode: 409, context: { details: { reason: 'organization_domain_taken' } } });
    expect(domainClaims.isDomainHeld).toHaveBeenCalledWith('acme.io', expect.any(Date));
    expect(createTenant).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('BUSINESS: the tenant insert and the PROVISIONAL claim run in ONE transaction', async () => {
    const { service, domainClaims, createTenant, withTransaction } = make();
    await service.provisionTenant({ name: 'Acme', owner_email: 'o@acme.io', actor_user_id: ACTOR_ID });
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(createTenant).toHaveBeenCalledWith(expect.objectContaining({ allowed_domain: 'acme.io' }), TX);
    expect(domainClaims.claimForNewTenant).toHaveBeenCalledWith(TX, { tenant_id: TENANT_A, domain: 'acme.io', now: expect.any(Date) });
  });

  it('a claim refusal inside the transaction propagates (the insert rolls back with it)', async () => {
    const { service, domainClaims } = make();
    domainClaims.claimForNewTenant.mockRejectedValue(Object.assign(new Error('x'), { code: 'TENANT_DOMAIN_UNAVAILABLE' }));
    await expect(service.provisionTenant({ name: 'Acme', owner_email: 'o@acme.io', actor_user_id: ACTOR_ID }))
      .rejects.toMatchObject({ code: 'TENANT_DOMAIN_UNAVAILABLE' });
  });

  it('PERSONAL is unaffected: no domain check, no claim, no transaction', async () => {
    const { service, domainClaims, createTenant, withTransaction } = make({ held: true });
    await service.provisionTenant({ name: 'Jane', owner_email: 'jane@gmail.com', actor_user_id: ACTOR_ID, kind: 'PERSONAL' });
    expect(domainClaims.isDomainHeld).not.toHaveBeenCalled();
    expect(domainClaims.claimForNewTenant).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
    expect(createTenant).toHaveBeenCalledWith(expect.objectContaining({ allowed_domain: null, kind: 'PERSONAL' }));
  });

  it('deactivateTenant (saga soft-disable) lapses the claim with reason provisioning_failed', async () => {
    const { service, domainClaims, deactivateTenant } = make();
    await service.deactivateTenant({ tenant_id: TENANT_A, actor_user_id: ACTOR_ID, reason: 'entitlement_grant_failed' });
    expect(deactivateTenant).toHaveBeenCalledWith({ id: TENANT_A });
    expect(domainClaims.lapse).toHaveBeenCalledWith(TENANT_A, 'provisioning_failed');
  });
});
