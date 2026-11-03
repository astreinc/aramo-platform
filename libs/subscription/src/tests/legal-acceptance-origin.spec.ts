import { describe, expect, it, vi } from 'vitest';

import { LegalAcceptanceService } from '../lib/legal/legal-acceptance.service.js';
import { LEGAL_DOCUMENTS } from '../lib/legal/legal-documents.js';

// Aramo-Sign-Mobile-Amendment-M-A11 §2 — a SIGNUP acceptance from the app records its
// origin (IP, user agent) in LegalAcceptanceOrigin, in the same transaction as the
// acceptance; without an origin the record is written exactly as before.

const doc = LEGAL_DOCUMENTS.find((d) => d.key === 'aramo.privacy_notice' && d.version === '1.0')!;

function prismaFake(existing: unknown = null) {
  const acceptance = { findFirst: vi.fn(async () => existing), create: vi.fn(async () => undefined) };
  const origin = { create: vi.fn(async () => undefined) };
  const tx = { legalAcceptance: acceptance, legalAcceptanceOrigin: origin };
  const prisma = { legalAcceptance: acceptance, legalAcceptanceOrigin: origin, $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
  return { prisma, acceptance, origin };
}

const base = { document: doc, context: 'SIGNUP' as const, context_ref: 'signup-1', tenant_id: 't', user_id: 'u', subject_email: 'p@gmail.com', accepted_at: new Date('2026-11-03T15:00:00Z') };

describe('LegalAcceptanceService.record — origin', () => {
  it('with an origin: the acceptance and its origin are written in one transaction (values clipped)', async () => {
    const f = prismaFake();
    await new LegalAcceptanceService(f.prisma as never).record({ ...base, origin: { ip: '203.0.113.9', user_agent: ` okhttp/4.12.0${'x'.repeat(600)} ` } });
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    const created = (f.acceptance.create.mock.calls[0] as unknown as [{ data: { id: string; sha256: string; context: string } }])[0].data;
    expect(created).toMatchObject({ sha256: doc.sha256, context: 'SIGNUP', context_ref: 'signup-1' });
    const o = (f.origin.create.mock.calls[0] as unknown as [{ data: { acceptance_id: string; ip: string; user_agent: string } }])[0].data;
    expect(o.acceptance_id).toBe(created.id);
    expect(o.ip).toBe('203.0.113.9');
    expect(o.user_agent.startsWith('okhttp/4.12.0')).toBe(true);
    expect(o.user_agent).toHaveLength(512);
  });

  it('without an origin: unchanged (no transaction, no origin row)', async () => {
    const f = prismaFake();
    await new LegalAcceptanceService(f.prisma as never).record(base);
    expect(f.acceptance.create).toHaveBeenCalledTimes(1);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.origin.create).not.toHaveBeenCalled();
  });

  it('idempotent: an existing acceptance writes nothing', async () => {
    const f = prismaFake({ id: 'x' });
    await new LegalAcceptanceService(f.prisma as never).record({ ...base, origin: { ip: null, user_agent: null } });
    expect(f.acceptance.create).not.toHaveBeenCalled();
    expect(f.origin.create).not.toHaveBeenCalled();
  });
});
