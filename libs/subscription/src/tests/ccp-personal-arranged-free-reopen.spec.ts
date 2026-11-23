import { describe, expect, it, vi } from 'vitest';

import { FREE_SUBSCRIPTION_SOURCE, FreePersonalPlanKey, openFreePersonalInTx } from '../lib/free-personal-subscription.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// CCP-PERSONAL-ARRANGED-1 P-8 (PO ruling D-5) — the FREE open as one step of the caller's transaction: the
// same gates as FreePersonalSubscriptionService.ensure; a refusal is returned, never thrown.

const AT = new Date('2026-11-24T12:00:00.000Z');
const T = '0190dddd-0000-7000-8000-00000000f001';

function fakeDb(o: { open?: { id: string; source: string } | null; plan?: { id: string; product_key: string } | null; version?: { id: string } | null } = {}) {
  const create = vi.fn(async (_args: unknown) => ({}));
  const db = {
    tenantSubscription: { findFirst: vi.fn(async () => o.open ?? null), create },
    plan: { findUnique: vi.fn(async () => (o.plan === undefined ? { id: 'plan-free', product_key: 'sign' } : o.plan)) },
    planVersion: { findFirst: vi.fn(async () => (o.version === undefined ? { id: 'ver-free' } : o.version)) },
  };
  return { db: db as unknown as PrismaService, create };
}
const input = (o: Partial<Parameters<typeof openFreePersonalInTx>[1]> = {}) => ({ tenant_id: T, product_key: 'sign' as const, tenant_kind: 'PERSONAL', tenant_status: 'ACTIVE', mode: 'open' as const, at: AT, ...o });

describe('CCP-PERSONAL-ARRANGED-1 openFreePersonalInTx', () => {
  it('ARR-U-FREE-1 opens a FREE row pinned to the published Free version, anchored at the given instant', async () => {
    const { db, create } = fakeDb();
    const r = await openFreePersonalInTx(db, input());
    expect(r).toMatchObject({ ok: true, opened: true, source: FREE_SUBSCRIPTION_SOURCE });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ data: { tenant_id: T, plan_id: 'plan-free', plan_version_id: 'ver-free', product_key: 'sign', composition_role: 'BASE', period_anchor: AT, source: 'FREE', status: 'ACTIVE' } });
  });

  it('ARR-U-FREE-2 the gates refuse without writing: mode off, not PERSONAL, not ACTIVE, no Free plan or version', async () => {
    const cases: Array<[Parameters<typeof fakeDb>[0], Partial<Parameters<typeof openFreePersonalInTx>[1]>, string]> = [
      [{}, { mode: 'off' }, 'personal_mode_off'],
      [{}, { tenant_kind: 'BUSINESS' }, 'tenant_not_personal'],
      [{}, { tenant_kind: null }, 'tenant_not_personal'],
      [{}, { tenant_status: 'SUSPENDED' }, 'tenant_not_active'],
      [{}, { tenant_status: null }, 'tenant_not_active'],
      [{ plan: null }, {}, 'plan_missing'],
      [{ plan: { id: 'p', product_key: 'ats' } }, {}, 'plan_missing'],
      [{ version: null }, {}, 'plan_missing'],
    ];
    for (const [d, i, reason] of cases) {
      const { db, create } = fakeDb(d);
      expect(await openFreePersonalInTx(db, input(i)), reason).toEqual({ ok: false, reason });
      expect(create).not.toHaveBeenCalled();
    }
  });

  it('ARR-U-FREE-3 an open row already there is kept (nothing is written)', async () => {
    const { db, create } = fakeDb({ open: { id: 'already', source: 'MANUAL' } });
    expect(await openFreePersonalInTx(db, input())).toEqual({ ok: true, opened: false, subscription_id: 'already', source: 'MANUAL' });
    expect(create).not.toHaveBeenCalled();
    expect(FreePersonalPlanKey).toBe('aramo-sign-free-personal-v1');
  });
});
