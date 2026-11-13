import { describe, expect, it, vi } from 'vitest';

import type { BillingProviderPort, ProviderSubscriptionState, VerifiedBillingEvent } from '../lib/billing/billing-provider.port.js';
import { BillingWebhookInboxService, type BillingWebhookInboxRow } from '../lib/billing/billing-webhook-inbox.service.js';
import { StaticBillingGatewayRegistry } from '../lib/billing/gateway-registry.js';
import { BILLING_PRICE_PROVIDER, effectiveProviderPrice, resolvePriceToVersion } from '../lib/billing/provider-price.js';
import { SubscriptionLifecycleService } from '../lib/billing/subscription-lifecycle.service.js';

// India Billing Regions + Razorpay (Implementation Directive v1.0 LOCKED §4.3) — routing by the row's
// provider: syncSubscription re-fetches a web row from ITS gateway (Stripe = exactly the bound port),
// the webhook inbox records and processes a Razorpay event as RAZORPAY, and the price pin / webhook
// price resolution take the gateway (STRIPE default; the STRIPE_PLAN_PRICES env never applies to
// Razorpay).

function state(provider: 'STRIPE' | 'RAZORPAY', ref: string): ProviderSubscriptionState {
  return { provider, subscription_ref: ref, account_ref: 'a', provider_status: 'active', current_period_start: new Date(0), current_period_end: new Date(0), cancel_at_period_end: false, price_ref: 'p', tenant_id: null, intent_id: null, account_country: null };
}

function port(provider: 'STRIPE' | 'RAZORPAY', configured = true) {
  return { provider, isConfigured: () => configured, mode: () => 'test', retrieveSubscription: vi.fn(async (ref: string) => state(provider, ref)) } as unknown as BillingProviderPort & { retrieveSubscription: ReturnType<typeof vi.fn> };
}

function lifecycle(stripe: BillingProviderPort, registry?: StaticBillingGatewayRegistry) {
  const svc = new SubscriptionLifecycleService({} as never, {} as never, stripe, {} as never, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, registry);
  const applied = vi.spyOn(svc, 'applyProviderState').mockImplementation(async (s) => ({ outcome: 'APPLIED', detail: `${s.provider} ${s.subscription_ref}`, tenant_id: 't' }));
  return { svc, applied };
}

describe('India Billing §4.3 — syncSubscription routes by the row provider', () => {
  it('STRIPE (and the default) is exactly the bound port; RAZORPAY is the registry gateway', async () => {
    const stripe = port('STRIPE');
    const razorpay = port('RAZORPAY');
    const { svc, applied } = lifecycle(stripe, new StaticBillingGatewayRegistry({ STRIPE: { billing: stripe }, RAZORPAY: { billing: razorpay } }));
    expect(await svc.syncSubscription('sub_s', 'sign')).toMatchObject({ outcome: 'APPLIED', detail: 'STRIPE sub_s' });
    expect(await svc.syncSubscription('sub_s2', 'sign', new Date(), undefined, 'STRIPE')).toMatchObject({ detail: 'STRIPE sub_s2' });
    expect(await svc.syncSubscription('sub_r', 'sign', new Date(), undefined, 'RAZORPAY')).toMatchObject({ outcome: 'APPLIED', detail: 'RAZORPAY sub_r' });
    expect(stripe.retrieveSubscription.mock.calls.map((c) => c[0])).toEqual(['sub_s', 'sub_s2']);
    expect(razorpay.retrieveSubscription.mock.calls.map((c) => c[0])).toEqual(['sub_r']);
    expect(applied).toHaveBeenCalledTimes(3);
  });

  it('a Razorpay row with no registry, or with Razorpay not configured (G-2), is IGNORED with no provider call', async () => {
    const stripe = port('STRIPE');
    const dark = port('RAZORPAY', false);
    for (const reg of [undefined, new StaticBillingGatewayRegistry({ STRIPE: { billing: stripe } }), new StaticBillingGatewayRegistry({ STRIPE: { billing: stripe }, RAZORPAY: { billing: dark } })]) {
      const { svc, applied } = lifecycle(stripe, reg);
      expect(await svc.syncSubscription('sub_r', 'sign', new Date(), undefined, 'RAZORPAY')).toEqual({ outcome: 'IGNORED', detail: 'RAZORPAY billing is not configured', tenant_id: null });
      expect(applied).not.toHaveBeenCalled();
    }
    expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
    expect(dark.retrieveSubscription).not.toHaveBeenCalled();
  });
});

describe('India Billing §4.3 — the webhook inbox records and processes a Razorpay event as RAZORPAY', () => {
  function inbox() {
    const created: Array<Record<string, unknown>> = [];
    let row: BillingWebhookInboxRow | null = null;
    const prisma = {
      billingWebhookInbox: {
        createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
          created.push(...data);
          const d = data[0] as Record<string, unknown>;
          row = { ...(d as unknown as BillingWebhookInboxRow), checkout_session_ref: (d['checkout_session_ref'] as string | null) ?? null, object_ref: (d['object_ref'] as string | undefined) ?? null, status: 'PROCESSING', attempts: 1, lease_until: null, next_attempt_at: null, outcome: null, detail: null, last_error: null, processed_at: null };
          return { count: 1 };
        }),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      $queryRaw: vi.fn(async () => (row === null ? [] : [row])),
    };
    const handled: VerifiedBillingEvent[] = [];
    const lc = { handleEvent: vi.fn(async (e: VerifiedBillingEvent) => { handled.push(e); return { outcome: 'APPLIED' as const, tenant_id: 't' }; }) };
    const svc = new BillingWebhookInboxService(prisma as never, port('STRIPE'), lc as never);
    return { svc, created, handled };
  }

  it('Razorpay: the row carries RAZORPAY and handleEvent receives provider RAZORPAY', async () => {
    const h = inbox();
    const evt: VerifiedBillingEvent = { provider: 'RAZORPAY', id: 'evt_1', type: 'subscription.charged', created: new Date(1000), subscription_ref: 'sub_r' };
    expect(await h.svc.receive(evt, 'sign')).toMatchObject({ outcome: 'APPLIED' });
    expect(h.created[0]).toMatchObject({ provider: 'RAZORPAY', provider_event_id: 'evt_1', subscription_ref: 'sub_r' });
    expect(h.handled[0]).toMatchObject({ provider: 'RAZORPAY', id: 'evt_1', subscription_ref: 'sub_r' });
  });

  it('Stripe (no provider on the event): unchanged — recorded STRIPE, processed with no provider (the bound port)', async () => {
    const h = inbox();
    await h.svc.receive({ id: 'evt_s', type: 'invoice.paid', created: new Date(1000), subscription_ref: 'sub_s' }, 'sign');
    expect(h.created[0]).toMatchObject({ provider: 'STRIPE' });
    expect(h.handled[0]?.provider).toBeUndefined();
  });
});

describe('India Billing §4.3 — provider prices per gateway', () => {
  function db(pins: Array<{ plan_version_id: string; provider: string; provider_price_ref: string }>) {
    const seen: unknown[] = [];
    const plan = { id: 'pl', key: 'k', sellable: true, product_key: 'sign' };
    return {
      seen,
      planVersionPrice: {
        findUnique: vi.fn(async ({ where }: { where: Record<string, { plan_version_id?: string; provider: string; provider_price_ref?: string }> }) => {
          seen.push(where);
          const w = where['plan_version_id_provider'] ?? where['provider_provider_price_ref'];
          const pin = pins.find((p) => p.provider === w?.provider && (w.plan_version_id === undefined || p.plan_version_id === w.plan_version_id) && (w.provider_price_ref === undefined || p.provider_price_ref === w.provider_price_ref));
          return pin === undefined ? null : { ...pin, plan_version: { id: pin.plan_version_id, plan_id: 'pl', status: 'PUBLISHED', plan } };
        }),
      },
      plan: { findUnique: vi.fn(async () => plan) },
      planVersion: { findFirst: vi.fn(async () => ({ id: 'v1', status: 'PUBLISHED', content: {} })) },
    };
  }
  const ENV = new Map([['k', 'price_env']]);

  it('effectiveProviderPrice: STRIPE by default (pin, env cutover); RAZORPAY reads its own pin and never the env', async () => {
    expect(BILLING_PRICE_PROVIDER).toBe('STRIPE');
    const d = db([{ plan_version_id: 'v1', provider: 'RAZORPAY', provider_price_ref: 'plan_rzp' }]);
    expect(await effectiveProviderPrice(d as never, 'v1', 'k', ENV)).toEqual({ ok: true, ref: 'price_env', source: 'ENV' });
    expect(await effectiveProviderPrice(d as never, 'v1', 'k', ENV, 'ACCOUNT', 'RAZORPAY')).toEqual({ ok: true, ref: 'plan_rzp', source: 'PIN' });
    expect(d.seen).toEqual([{ plan_version_id_provider: { plan_version_id: 'v1', provider: 'STRIPE' } }, { plan_version_id_provider: { plan_version_id: 'v1', provider: 'RAZORPAY' } }]);
    const none = db([]);
    expect(await effectiveProviderPrice(none as never, 'v1', 'k', ENV, 'ACCOUNT', 'RAZORPAY')).toEqual({ ok: false, reason: 'NO_PRICE' });
  });

  it('resolvePriceToVersion: a Razorpay plan id resolves through its RAZORPAY pin only (no env fallback)', async () => {
    const d = db([{ plan_version_id: 'v1', provider: 'RAZORPAY', provider_price_ref: 'plan_rzp' }]);
    expect(await resolvePriceToVersion(d as never, 'plan_rzp', 'sign', ENV, 'RAZORPAY')).toEqual({ plan_id: 'pl', plan_version_id: 'v1', version_status: 'PUBLISHED', source: 'PIN' });
    // The Stripe lookup of the same ref finds no Stripe pin.
    expect(d.seen[0]).toEqual({ provider_provider_price_ref: { provider: 'RAZORPAY', provider_price_ref: 'plan_rzp' } });
    // An env-mapped Stripe price never resolves as a Razorpay price.
    expect(await resolvePriceToVersion(db([]) as never, 'price_env', 'sign', ENV, 'RAZORPAY')).toBeNull();
    expect(d.plan.findUnique).not.toHaveBeenCalled();
  });
});
