import { describe, expect, it, vi } from 'vitest';

import { SubscriptionLifecycleService } from '../lib/billing/subscription-lifecycle.service.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// CCP-PERSONAL-ARRANGED-1 PO ruling D-7 — the server rule behind "after a release the normal upgrade offer
// shows again": the plan an open CONVERSION TO_SELF_SERVICE release of the tenant's open ARRANGED row lets the
// user buy, else null. Reads only.

const AT = new Date('2026-11-24T12:00:00.000Z');
const T = '0190dddd-0000-7000-8000-00000000d701';
const ROW = '0190dddd-0000-7000-8000-00000000d702';

type Open = { id: string; source: string; ended_at: Date | null; arrangement: string | null } | null;
type Release = { plan_id: string; state: string; expires_at: Date } | null;

function service(o: { open?: Open; release?: Release; plan?: { key: string } | null } = {}) {
  const open: Open = o.open === undefined ? { id: ROW, source: 'MANUAL', ended_at: null, arrangement: 'COMP' } : o.open;
  const release: Release = o.release === undefined ? { plan_id: 'plan-std', state: 'RELEASED', expires_at: new Date(AT.getTime() + 3_600_000) } : o.release;
  const prisma = {
    tenantSubscription: { findFirst: vi.fn(async () => open) },
    commercialConversionRelease: { findFirst: vi.fn(async (_args: unknown) => release) },
    plan: { findUnique: vi.fn(async () => (o.plan === undefined ? { key: 'aramo-sign-standard-personal-v1' } : o.plan)) },
  };
  const svc = new SubscriptionLifecycleService(prisma as unknown as PrismaService, {} as never, {} as never, {} as never);
  return { svc, prisma };
}

describe('CCP-PERSONAL-ARRANGED-1 D-7 arrangedReleasePlanKey', () => {
  it('ARR-U-REL-1 an open release of the open arranged row: the released plan key (looked up for that row, not a held adoption)', async () => {
    const { svc, prisma } = service();
    expect(await svc.arrangedReleasePlanKey(T, 'sign', AT)).toBe('aramo-sign-standard-personal-v1');
    expect(prisma.commercialConversionRelease.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { tenant_id: T, product_key: 'sign', state: 'RELEASED', held_subscription_ref: null, governed_subscription_id: ROW },
    });
  });

  it('ARR-U-REL-2 an AGREED row is arranged too', async () => {
    expect(await service({ open: { id: ROW, source: 'MANUAL', ended_at: null, arrangement: 'AGREED' } }).svc.arrangedReleasePlanKey(T, 'sign', AT)).toBe('aramo-sign-standard-personal-v1');
  });

  it.each([
    ['no open row', { open: null }],
    ['the open row is not arranged', { open: { id: ROW, source: 'MANUAL', ended_at: null, arrangement: null } }],
    ['the open row is not governed', { open: { id: ROW, source: 'SELF_SERVICE', ended_at: null, arrangement: 'COMP' } }],
    ['no release', { release: null }],
    ['the release expired (half-open window)', { release: { plan_id: 'plan-std', state: 'RELEASED', expires_at: AT } }],
    ['the released plan is gone', { plan: null }],
  ] as const)('ARR-U-REL-3 null when %s', async (_n, o) => {
    expect(await service(o as Parameters<typeof service>[0]).svc.arrangedReleasePlanKey(T, 'sign', AT)).toBeNull();
  });

  it('ARR-U-REL-4 a row that is not arranged never reads a release', async () => {
    const { svc, prisma } = service({ open: { id: ROW, source: 'MANUAL', ended_at: null, arrangement: null } });
    await svc.arrangedReleasePlanKey(T, 'sign', AT);
    expect(prisma.commercialConversionRelease.findFirst).not.toHaveBeenCalled();
  });
});
