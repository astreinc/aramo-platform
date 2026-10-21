import { afterEach, describe, expect, it, vi } from 'vitest';

import { StripeBillingProvider, stripeEventSubscriptionRef, stripeSubscriptionState } from '../lib/billing/stripe-billing.provider.js';
import {
  isWireSubscriptionEvent,
  wireAccountCountry,
  wireAccountParams,
  wireAccountPath,
  wireAccountRef,
  wireCheckoutAccountParams,
  wirePortalAccountParams,
  wireSubscriptionQuery,
} from '../lib/billing/stripe-wire.js';

// Aramo Sign launch — boundary CONTRACT tests for the Stripe wire translation
// (Architect ruling: vendor names stay at the boundary; Aramo-owned shapes use
// account_ref). Vocabulary-exempt together with stripe-wire.ts because the
// fixtures are Stripe-shaped; no Aramo logic lives here.

const ARAMO_KEYS = ['provider', 'subscription_ref', 'account_ref', 'provider_status', 'current_period_start', 'current_period_end', 'cancel_at_period_end', 'price_ref', 'tenant_id', 'intent_id', 'account_country'];

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
    // An unexpanded account carries no country: fail closed.
    expect(s.account_country).toBeNull();
    expect(Object.keys(s).sort()).toEqual([...ARAMO_KEYS].sort());
  });

  it('reads the billing country from the expanded account (Sign Signup A1 §2.6)', () => {
    const s = stripeSubscriptionState({ id: 'sub_1', status: 'active', customer: { id: 'cus_1', object: 'customer', address: { country: 'US', state: 'TX' } } });
    expect(s).toMatchObject({ account_ref: 'cus_1', account_country: 'US' });
    expect(wireAccountCountry({ customer: { id: 'cus_1', address: { country: 'CA' } } })).toBe('CA');
    expect(wireAccountCountry({ customer: { id: 'cus_1', address: null } })).toBeNull();
    expect(wireAccountCountry({ customer: { id: 'cus_1', deleted: true } })).toBeNull();
    expect(wireAccountCountry({ customer: 'cus_1' })).toBeNull();
    expect(wireSubscriptionQuery()).toBe('expand%5B%5D=customer');
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
    expect(wireCheckoutAccountParams('cus_1', 'o@acme.test')).toEqual({ customer: 'cus_1', 'customer_update[address]': 'never' });
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
    // A1 §2.6 — Checkout runs on Aramo's account; the address is not updatable there.
    expect(bodies.get('/v1/checkout/sessions')!.get('customer_update[address]')).toBe('never');
    expect(bodies.get('/v1/checkout/sessions')!.get('billing_address_collection')).toBe('auto');
    await p.createPortalSession('cus_9', 'https://e/settings');
    expect(bodies.get('/v1/billing_portal/sessions')!.get('customer')).toBe('cus_9');
  });

  it('creates, then updates, the billing account from the organization profile (Sign Signup A1 §2.6)', async () => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_local';
    process.env['STRIPE_API_BASE'] = 'http://stripe.test';
    const calls: { path: string; body: URLSearchParams; key: string | null; method: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ path: new URL(url).pathname, body: new URLSearchParams(String(init.body)), key: headers['idempotency-key'] ?? null, method: String(init.method) });
      return new Response(JSON.stringify({ id: 'cus_new', object: 'customer' }), { status: 200 });
    }));
    const details = {
      tenant_id: 't1',
      legal_name: 'Acme Holdings LLC',
      billing_email: 'billing@acme.test',
      address: { line1: '1 Main St', line2: null, city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' },
    };
    expect(wireAccountPath(null)).toBe('/v1/customers');
    expect(wireAccountPath('cus_1')).toBe('/v1/customers/cus_1');
    expect(wireAccountParams(details)).toEqual({
      name: 'Acme Holdings LLC',
      email: 'billing@acme.test',
      'address[line1]': '1 Main St',
      'address[line2]': '',
      'address[city]': 'Austin',
      'address[state]': 'TX',
      'address[postal_code]': '78701',
      'address[country]': 'US',
      'metadata[tenant_id]': 't1',
    });
    const p = new StripeBillingProvider();
    expect(await p.upsertBillingAccount(null, details)).toBe('cus_new');
    expect(calls[0]).toMatchObject({ path: '/v1/customers', method: 'POST' });
    expect(calls[0]!.key).toMatch(/^aramo-billing-account-t1-[0-9a-f]{16}$/);
    expect(Object.fromEntries(calls[0]!.body)).toEqual(wireAccountParams(details));
    await p.upsertBillingAccount('cus_7', { ...details, address: { ...details.address, line2: 'Suite 9' } });
    expect(calls[1]).toMatchObject({ path: '/v1/customers/cus_7', method: 'POST', key: null });
    expect(calls[1]!.body.get('address[line2]')).toBe('Suite 9');
  });

  it('retrieves the subscription with the account expanded', async () => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_local';
    process.env['STRIPE_API_BASE'] = 'http://stripe.test';
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ id: 'sub_1', status: 'active', customer: { id: 'cus_1', address: { country: 'US' } } }), { status: 200 });
    }));
    expect(await new StripeBillingProvider().retrieveSubscription('sub_1')).toMatchObject({ account_ref: 'cus_1', account_country: 'US' });
    expect(new URL(urls[0]!).searchParams.getAll('expand[]')).toEqual(['customer']);
  });
});
