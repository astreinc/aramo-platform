import { describe, expect, it, vi } from 'vitest';

import {
  DOMAIN_CLAIM_PROVISIONAL_DAYS,
  DomainClaimService,
  isHolderIndexViolation,
  type DomainClaimTx,
} from '../lib/domain-claim/domain-claim.service.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// Domain-Enforcement P3 (LOCKED) §7 (unit) — the domain-claim primitives: P2002
// mapping on the holder index, free-mail never held, expired provisional holders
// do not count, and the claim is written PROVISIONAL for 30 days. The real-
// Postgres behaviour (lock, index, lapse, exceptions) is proven in
// domain-claim.integration.spec.ts.

const TENANT = '01900000-0000-7000-8000-0000000000c1';
const NOW = new Date('2026-10-21T12:00:00.000Z');

function p2002(meta: unknown): Error {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta });
}

function makeTx(opts: { holder?: unknown; createError?: Error } = {}) {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    tenant: { findUnique: vi.fn() },
    tenantDomainClaim: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(opts.holder ?? null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: opts.createError === undefined ? vi.fn().mockResolvedValue({}) : vi.fn().mockRejectedValue(opts.createError),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    tenantDomainException: { create: vi.fn(), updateMany: vi.fn() },
    identityAuditEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  return tx;
}

describe('isHolderIndexViolation', () => {
  it('maps a P2002 naming the holder index (or the domain column) — not the tenant_id primary key', () => {
    expect(isHolderIndexViolation(p2002({ target: 'TenantDomainClaim_holder_key' }))).toBe(true);
    expect(isHolderIndexViolation(p2002({ target: ['domain'] }))).toBe(true);
    expect(isHolderIndexViolation(p2002(undefined))).toBe(true);
    expect(isHolderIndexViolation(p2002({ target: 'TenantDomainClaim_pkey' }))).toBe(false);
    expect(isHolderIndexViolation(p2002({ target: ['tenant_id'] }))).toBe(false);
    expect(isHolderIndexViolation(Object.assign(new Error('x'), { code: 'P2003' }))).toBe(false);
    expect(isHolderIndexViolation(null)).toBe(false);
  });
});

describe('DomainClaimService — free-mail is never held', () => {
  it('isDomainHeld is false for a personal / disposable domain without reading the store', async () => {
    const findFirst = vi.fn();
    const svc = new DomainClaimService({ tenantDomainClaim: { findFirst } } as unknown as PrismaService);
    expect(await svc.isDomainHeld('gmail.com')).toBe(false);
    expect(await svc.isDomainHeld('MAILINATOR.com')).toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('claimForNewTenant writes nothing for a free-mail domain', async () => {
    const svc = new DomainClaimService({} as PrismaService);
    const tx = makeTx();
    await svc.claimForNewTenant(tx as unknown as DomainClaimTx, { tenant_id: TENANT, domain: 'gmail.com', now: NOW });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.tenantDomainClaim.create).not.toHaveBeenCalled();
  });
});

describe('DomainClaimService.isDomainHeld', () => {
  it('a live holder holds; an expired provisional holder does not; matching is case-insensitive', async () => {
    const findFirst = vi.fn();
    const svc = new DomainClaimService({ tenantDomainClaim: { findFirst } } as unknown as PrismaService);
    findFirst.mockResolvedValueOnce({ claim: 'AUTHORITATIVE', expires_at: null });
    expect(await svc.isDomainHeld(' Acme.IO ', NOW)).toBe(true);
    expect(findFirst).toHaveBeenLastCalledWith({
      where: { domain: 'acme.io', claim: { in: ['PROVISIONAL', 'AUTHORITATIVE'] }, exception: false },
    });
    findFirst.mockResolvedValueOnce({ claim: 'PROVISIONAL', expires_at: new Date(NOW.getTime() - 1) });
    expect(await svc.isDomainHeld('acme.io', NOW)).toBe(false);
    findFirst.mockResolvedValueOnce({ claim: 'PROVISIONAL', expires_at: new Date(NOW.getTime() + 1) });
    expect(await svc.isDomainHeld('acme.io', NOW)).toBe(true);
    findFirst.mockResolvedValueOnce(null);
    expect(await svc.isDomainHeld('acme.io', NOW)).toBe(false);
  });
});

describe('DomainClaimService.claimForNewTenant', () => {
  const svc = new DomainClaimService({} as PrismaService);

  it('locks the domain, then claims PROVISIONAL for 30 days (reason provisioned) and audits in the same tx', async () => {
    const tx = makeTx();
    await svc.claimForNewTenant(tx as unknown as DomainClaimTx, { tenant_id: TENANT, domain: 'Acme.io', now: NOW });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.tenantDomainClaim.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenant_id: TENANT,
        domain: 'acme.io',
        claim: 'PROVISIONAL',
        reason: 'provisioned',
        expires_at: new Date(NOW.getTime() + DOMAIN_CLAIM_PROVISIONAL_DAYS * 24 * 60 * 60 * 1000),
      }),
    });
    expect(tx.identityAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ event_type: 'identity.domain.claim.provisional', tenant_id: TENANT, subject_id: TENANT }),
    });
  });

  it('a remaining holder → 409 TENANT_DOMAIN_UNAVAILABLE, no insert', async () => {
    const tx = makeTx({ holder: { tenant_id: 'other', claim: 'AUTHORITATIVE' } });
    await expect(svc.claimForNewTenant(tx as unknown as DomainClaimTx, { tenant_id: TENANT, domain: 'acme.io', now: NOW }))
      .rejects.toMatchObject({ code: 'TENANT_DOMAIN_UNAVAILABLE', statusCode: 409, context: { details: { reason: 'organization_domain_taken' } } });
    expect(tx.tenantDomainClaim.create).not.toHaveBeenCalled();
  });

  it('a holder-index P2002 maps to the same refusal; any other error is rethrown', async () => {
    const lost = makeTx({ createError: p2002({ target: 'TenantDomainClaim_holder_key' }) });
    await expect(svc.claimForNewTenant(lost as unknown as DomainClaimTx, { tenant_id: TENANT, domain: 'acme.io', now: NOW }))
      .rejects.toMatchObject({ code: 'TENANT_DOMAIN_UNAVAILABLE' });
    const other = makeTx({ createError: p2002({ target: 'TenantDomainClaim_pkey' }) });
    await expect(svc.claimForNewTenant(other as unknown as DomainClaimTx, { tenant_id: TENANT, domain: 'acme.io', now: NOW }))
      .rejects.toMatchObject({ code: 'P2002' });
  });

  it('an expired provisional holder is lapsed (reason reservation_expired) before the check', async () => {
    const tx = makeTx();
    tx.tenantDomainClaim.findMany.mockResolvedValue([{ tenant_id: 'old', domain: 'acme.io', claim: 'PROVISIONAL' }]);
    await svc.claimForNewTenant(tx as unknown as DomainClaimTx, { tenant_id: TENANT, domain: 'acme.io', now: NOW });
    expect(tx.tenantDomainClaim.update).toHaveBeenCalledWith({
      where: { tenant_id: 'old' },
      data: { claim: 'LAPSED', reason: 'reservation_expired', updated_at: NOW },
    });
    expect(tx.tenantDomainClaim.create).toHaveBeenCalled();
  });
});
