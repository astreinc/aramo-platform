import { describe, expect, it, vi } from 'vitest';

import { SignTemplateEntitlementService } from '../lib/sign-template-entitlement.service.js';

// Aramo Sign Feature-Parity 1.1 — whether the Sign plan includes templates
// (Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §5 D-1; Catalog v2 P-6).
//   Free (sales_model FREE) → NONE (P-6), whatever its capacity row says
//   every paid plan and the operator plan → INCLUDED
//   a subscription that does not send → NONE; no open subscription → NOT_SUBSCRIBED

const TENANT = '11111111-1111-7111-8111-111111111111';
const AT = new Date('2026-11-02T00:00:00Z');

function harness(sub: { status?: string; grace_until?: Date | null; plan: { key: string; sales_model: string } } | null) {
  const prisma = {
    tenantSubscription: {
      findFirst: vi.fn(async () => (sub === null ? null : { status: sub.status ?? 'ACTIVE', grace_until: sub.grace_until ?? null, plan: sub.plan })),
    },
  };
  return { svc: new SignTemplateEntitlementService(prisma as never), prisma };
}

describe('SignTemplateEntitlementService', () => {
  it('reads only the tenant’s open BASE Sign subscription', async () => {
    const h = harness(null);
    await h.svc.of(TENANT, AT);
    expect(h.prisma.tenantSubscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenant_id: TENANT, product_key: 'sign', composition_role: 'BASE', ended_at: null } }),
    );
  });

  it('no open subscription → NOT_SUBSCRIBED', async () => {
    expect(await harness(null).svc.of(TENANT, AT)).toEqual({ kind: 'NOT_SUBSCRIBED' });
  });

  it('P-6 — the Free plan never has templates', async () => {
    const h = harness({ plan: { key: 'aramo-sign-free-personal-v1', sales_model: 'FREE' } });
    expect(await h.svc.of(TENANT, AT)).toEqual({ kind: 'NONE', plan_key: 'aramo-sign-free-personal-v1', reason: 'free_plan' });
  });

  it('every paid plan and the operator plan include templates', async () => {
    for (const plan of [
      { key: 'aramo-sign-standard-personal-v1', sales_model: 'SELF_SERVICE' },
      { key: 'aramo-sign-standard-business-v1', sales_model: 'SELF_SERVICE' },
      { key: 'aramo-sign-standard-professional-v1', sales_model: 'SELF_SERVICE' },
      { key: 'aramo-sign-enterprise-v1', sales_model: 'CONTACT_SALES' },
      { key: 'aramo-sign-included-v1', sales_model: 'OPERATOR' },
    ]) {
      expect(await harness({ plan }).svc.of(TENANT, AT)).toEqual({ kind: 'INCLUDED', plan_key: plan.key });
    }
  });

  it('a subscription that does not send (cancelled, incomplete, past its grace) → NONE', async () => {
    const plan = { key: 'aramo-sign-standard-business-v1', sales_model: 'SELF_SERVICE' };
    for (const sub of [{ status: 'CANCELED' }, { status: 'INCOMPLETE' }, { status: 'PAST_DUE', grace_until: new Date('2026-11-01T00:00:00Z') }]) {
      expect(await harness({ ...sub, plan }).svc.of(TENANT, AT)).toEqual({ kind: 'NONE', plan_key: plan.key, reason: 'subscription_inactive' });
    }
    expect((await harness({ status: 'PAST_DUE', grace_until: new Date('2026-11-05T00:00:00Z'), plan }).svc.of(TENANT, AT)).kind).toBe('INCLUDED');
  });
});
