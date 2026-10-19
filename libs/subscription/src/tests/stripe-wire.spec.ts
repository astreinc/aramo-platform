import { afterEach, describe, expect, it, vi } from 'vitest';

import { StripeBillingProvider, stripeEventSubscriptionRef, stripeSubscriptionState } from '../lib/billing/stripe-billing.provider.js';
import { isWireSubscriptionEvent, wireAccountRef, wireCheckoutAccountParams, wirePortalAccountParams } from '../lib/billing/stripe-wire.js';

// Aramo Sign launch — boundary CONTRACT tests for the Stripe wire translation
// (Architect ruling: vendor names stay at the boundary; Aramo-owned shapes use
// account_ref). Vocabulary-exempt together with stripe-wire.ts because the
// fixtures are Stripe-shaped; no Aramo logic lives here.

const ARAMO_KEYS = ['provider', 'subscription_ref', 'account_ref', 'provider_status', 'current_period_start', 'current_period_end', 'cancel_at_period_end', 'price_ref', 'tenant_id', 'intent_id'];

describe('Stripe wire → Aramo', () => {
  it('reads the account id from a string or an expanded object', () => {
    expect(wireAccountRef({ customer: 'cus_1' })).toBe('cus_1');
    expect(wireAccountRef({ customer: { id: 'cus_2', object: 'customer' } })).toBe('cus_2');
    expect(wireAccountRef({})).toBe('');
  });

  it('a Stripe subscription becomes an Aramo state with account_ref and no vendor key', () => {
    const s = stripeSubscriptionState({
      id: 'sub_1',
      customer: { id: 'cus_1' },
      status: 'active',
      cancel_at_period_end: true,
      metadata: { tenant_id: 't1', intent_id: 'i1' },
      items: { data: [{ price: { id: 'price_A' }, current_period_start: 100, current_period_end: 200 }] },
    });
    expect(s).toMatchObject({ account_ref: 'cus_1', price_ref: 'price_A', tenant_id: 't1', intent_id: 'i1', cancel_at_period_end: true });
    expect(s.current_period_end.getTime()).toBe(200_000);
    expect(Object.keys(s).sort()).toEqual([...ARAMO_KEYS].sort());
  });

  it('recognizes Stripe subscription lifecycle events', () => {
    expect(isWireSubscriptionEvent('customer.subscription.updated')).toBe(true);
    expect(isWireSubscriptionEvent('customer.updated')).toBe(false);
    expect(stripeEventSubscriptionRef('customer.subscription.deleted', { id: 'sub_2' })).toBe('sub_2');
  });
});

describe('Aramo → Stripe wire', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });

  it('maps account_ref (or the first-checkout email) and the portal account', () => {
    expect(wireCheckoutAccountParams('cus_1', 'o@acme.test')).toEqual({ customer: 'cus_1' });
    expect(wireCheckoutAccountParams(null, 'o@acme.test')).toEqual({ customer_email: 'o@acme.test' });
    expect(wirePortalAccountParams('cus_1')).toEqual({ customer: 'cus_1' });
  });

  it('checkout and portal requests carry the vendor parameter names', async () => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_local';
    process.env['STRIPE_API_BASE'] = 'http://stripe.test';
    const bodies = new Map<string, URLSearchParams>();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      bodies.set(new URL(url).pathname, new URLSearchParams(String(init.body)));
      return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.test/x' }), { status: 200 });
    }));
    const p = new StripeBillingProvider();
    const req = { intent_id: 'i', tenant_id: 't', user_id: 'u', user_email: 'o@acme.test', price_ref: 'price_A', success_url: 'https://e/ok', cancel_url: 'https://e/no' };
    await p.createCheckoutSession({ ...req, account_ref: null });
    expect(bodies.get('/v1/checkout/sessions')!.get('customer_email')).toBe('o@acme.test');
    expect(bodies.get('/v1/checkout/sessions')!.has('customer')).toBe(false);
    await p.createCheckoutSession({ ...req, account_ref: 'cus_9' });
    expect(bodies.get('/v1/checkout/sessions')!.get('customer')).toBe('cus_9');
    expect(bodies.get('/v1/checkout/sessions')!.has('customer_email')).toBe(false);
    await p.createPortalSession('cus_9', 'https://e/settings');
    expect(bodies.get('/v1/billing_portal/sessions')!.get('customer')).toBe('cus_9');
  });
});
