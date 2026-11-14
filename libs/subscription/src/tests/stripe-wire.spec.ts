import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adjustmentRequestOf } from '../lib/billing/billing-provider-command.js';
import {
  StripeBillingProvider,
  stripeEventSubscriptionRef,
  stripeInvoicePaymentRef,
  stripeSubscriptionDiscount,
  stripeSubscriptionState,
} from '../lib/billing/stripe-billing.provider.js';
import { StripeBillingReadAdapter } from '../lib/billing/stripe-billing-read.adapter.js';
import {
  isWireSubscriptionEvent,
  wireAccountCountry,
  wireAccountParams,
  wireAccountPath,
  wireAccountRef,
  wireCheckoutAccountParams,
  wireInvoiceListPath,
  wireInvoicePayment,
  wireInvoiceQuery,
  wireInvoiceState,
  wireListData,
  wirePortalAccountParams,
  wirePortalConfigurationPath,
  wirePortalConfigurationState,
  wireSubscriptionDiscountClearParams,
  wireSubscriptionDiscountExpandParams,
  wireSubscriptionDiscountQuery,
  wireSubscriptionDiscounts,
  wireSubscriptionQuery,
} from '../lib/billing/stripe-wire.js';

// Aramo Sign launch — boundary CONTRACT tests for the Stripe wire translation
// (Architect ruling: vendor names stay at the boundary; Aramo-owned shapes use
// account_ref). Vocabulary-exempt together with stripe-wire.ts because the
// fixtures are Stripe-shaped; no Aramo logic lives here.

const ARAMO_KEYS = ['provider', 'subscription_ref', 'account_ref', 'provider_status', 'current_period_start', 'current_period_end', 'cancel_at_period_end', 'price_ref', 'tenant_id', 'intent_id', 'account_country', 'item_ref', 'quantity'];

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

  // Stripe API Upgrade directive v1.0 B-7 / B-8 — 2026-09-30.endive payloads ONLY (no older field present).
  it('B-7 a subscription with its period ONLY on the item (no subscription-level period fields) reads the item period', () => {
    const sub = {
      id: 'sub_7',
      object: 'subscription',
      customer: { id: 'cus_7', address: { country: 'US' } },
      status: 'active',
      cancel_at_period_end: false,
      billing_mode: { type: 'flexible' },
      discounts: [],
      metadata: { tenant_id: 't7' },
      items: { object: 'list', data: [{ id: 'si_7', quantity: 4, price: { id: 'price_7' }, current_period_start: 1_790_000_000, current_period_end: 1_792_592_000 }] },
    };
    expect(Object.keys(sub)).not.toContain('current_period_start');
    const s = stripeSubscriptionState(sub);
    expect(s).toMatchObject({ subscription_ref: 'sub_7', account_ref: 'cus_7', account_country: 'US', price_ref: 'price_7', item_ref: 'si_7', quantity: 4, tenant_id: 't7' });
    expect(s.current_period_start.getTime()).toBe(1_790_000_000_000);
    expect(s.current_period_end.getTime()).toBe(1_792_592_000_000);
  });

  it('B-8 an invoice event linked ONLY through parent.subscription_details names its subscription', () => {
    const inv = { id: 'in_8', object: 'invoice', customer: 'cus_8', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_8', metadata: {} } } };
    expect(Object.keys(inv)).not.toContain('subscription');
    for (const type of ['invoice.paid', 'invoice.payment_failed', 'invoice.finalized']) expect(stripeEventSubscriptionRef(type, inv)).toBe('sub_8');
    expect(stripeEventSubscriptionRef('invoice.paid', { ...inv, parent: { type: 'subscription_details', subscription_details: { subscription: { id: 'sub_8x' } } } })).toBe('sub_8x');
    expect(wireInvoiceState(inv)).toMatchObject({ invoice_ref: 'in_8', subscription_ref: 'sub_8', account_ref: 'cus_8' });
    // A one-off invoice (no subscription parent) names none.
    expect(stripeEventSubscriptionRef('invoice.paid', { id: 'in_9', parent: null })).toBeNull();
  });

  it('B-2/B-3 a subscription\'s discounts (the list, coupon under source.coupon; an unexpanded entry is a bare id)', () => {
    expect(wireSubscriptionDiscountQuery()).toBe('expand%5B%5D=discounts');
    expect(wireSubscriptionDiscountExpandParams()).toEqual({ 'expand[]': 'discounts' });
    expect(wireSubscriptionDiscountClearParams()).toEqual({ discounts: '' });
    expect(
      wireSubscriptionDiscounts({
        discounts: [{ id: 'di_1', object: 'discount', source: { type: 'coupon', coupon: 'aramo-c' } }, { id: 'di_2', source: { type: 'coupon', coupon: { id: 'other', object: 'coupon' } } }, 'di_3', null, ''],
      }),
    ).toEqual([
      { coupon_ref: 'aramo-c', discount_ref: 'di_1' },
      { coupon_ref: 'other', discount_ref: 'di_2' },
      { coupon_ref: null, discount_ref: 'di_3' },
    ]);
    // The removed singular field is not read.
    expect(wireSubscriptionDiscounts({ discount: { id: 'di_old', coupon: { id: 'aramo-c' } } })).toEqual([]);
    expect(wireSubscriptionDiscounts({ discounts: [] })).toEqual([]);
    expect(stripeSubscriptionDiscount({ discounts: [{ id: 'di_0', source: { coupon: 'x' } }, { id: 'di_1', source: { coupon: 'aramo-c' } }] }, 'aramo-c')).toEqual({ coupon_ref: 'aramo-c', discount_ref: 'di_1' });
    expect(stripeSubscriptionDiscount({ discounts: [{ id: 'di_0', source: { coupon: 'x' } }] }, 'aramo-c')).toEqual({ coupon_ref: 'x', discount_ref: 'di_0' });
    expect(stripeSubscriptionDiscount({ discounts: [] }, 'aramo-c')).toEqual({ coupon_ref: null, discount_ref: null });
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
    expect(bodies.get('/v1/checkout/sessions')!.has('custom_text[submit][message]')).toBe(false);
    await p.createPortalSession('cus_9', 'https://e/settings');
    expect(bodies.get('/v1/billing_portal/sessions')!.get('customer')).toBe('cus_9');
  });

  it('Sign Catalog v2 §4.3 — a Personal checkout collects the address and shows the renewal disclosure', async () => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_local';
    process.env['STRIPE_API_BASE'] = 'http://stripe.test';
    const bodies: URLSearchParams[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(new URLSearchParams(String(init.body)));
      return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.test/x' }), { status: 200 });
    }));
    const p = new StripeBillingProvider();
    const req = { intent_id: 'i', tenant_id: 't', user_id: 'u', user_email: 'me@example.test', price_ref: 'price_P', success_url: 'https://e/ok', cancel_url: 'https://e/no', collect_address: true, disclosure: 'Renews monthly.' };
    await p.createCheckoutSession({ ...req, account_ref: null });
    expect(bodies[0]!.get('customer_email')).toBe('me@example.test');
    expect(bodies[0]!.get('billing_address_collection')).toBe('required');
    expect(bodies[0]!.get('custom_text[submit][message]')).toBe('Renews monthly.');
    // A reused billing account: the collected address is saved on it.
    await p.createCheckoutSession({ ...req, account_ref: 'cus_7' });
    expect(bodies[1]!.get('customer')).toBe('cus_7');
    expect(bodies[1]!.get('customer_update[address]')).toBe('auto');
    expect(bodies[1]!.get('billing_address_collection')).toBe('required');
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

// CCP-C3 (PBD §5.2 row C3) — boundary CONTRACT tests for the read-through translation and the
// GET-only read adapter. The fixtures are Stripe-shaped (they carry Stripe's own account field),
// which is why they live in this exempt spec. Test IDs are cited by CCP-C3-acceptance.md.

const STRIPE_INVOICE = {
  id: 'in_1',
  object: 'invoice',
  number: 'ARAMO-0001',
  customer: 'cus_1',
  // 2026-09-30.endive shape (B-8): the subscription link sits under parent.subscription_details only.
  parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } },
  status: 'open',
  currency: 'usd',
  total: 4900,
  amount_due: 4900,
  amount_paid: 0,
  amount_remaining: 4900,
  created: 1_790_000_000,
  due_date: 1_790_600_000,
  period_start: 1_789_000_000,
  period_end: 1_790_000_000,
  attempt_count: 1,
  next_payment_attempt: 1_790_100_000,
  hosted_invoice_url: 'https://invoice.stripe.test/i/in_1',
  invoice_pdf: 'https://pay.stripe.test/in_1.pdf',
  livemode: false,
};

const STRIPE_PORTAL_CONFIGURATION = {
  id: 'bpc_terms',
  object: 'billing_portal.configuration',
  active: true,
  is_default: false,
  livemode: false,
  features: {
    customer_update: { enabled: true },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true, mode: 'at_period_end' },
    subscription_update: { enabled: false },
  },
};

describe('CCP-C3 Stripe read wire → Aramo', () => {
  it('C3-W-1 a Stripe invoice becomes an Aramo status mirror with account_ref (pinned and newer API shapes)', () => {
    const inv = wireInvoiceState(STRIPE_INVOICE);
    expect(inv).toEqual({
      invoice_ref: 'in_1',
      number: 'ARAMO-0001',
      account_ref: 'cus_1',
      subscription_ref: 'sub_1',
      provider_status: 'open',
      currency: 'usd',
      total_minor: 4900,
      amount_due_minor: 4900,
      amount_paid_minor: 0,
      amount_remaining_minor: 4900,
      created_at: new Date(1_790_000_000_000),
      due_at: new Date(1_790_600_000_000),
      period_start: new Date(1_789_000_000_000),
      period_end: new Date(1_790_000_000_000),
      attempt_count: 1,
      next_attempt_at: new Date(1_790_100_000_000),
      hosted_url: 'https://invoice.stripe.test/i/in_1',
      document_url: 'https://pay.stripe.test/in_1.pdf',
      live: false,
    });
    // No vendor account key survives the translation.
    expect(Object.keys(inv)).not.toContain('customer');
    // Pinned API (2026-09-30.endive): the subscription sits under parent.subscription_details; the account may be expanded.
    const newer = wireInvoiceState({ id: 'in_2', status: 'paid', customer: { id: 'cus_1' }, parent: { subscription_details: { subscription: 'sub_1' } } });
    expect(newer).toMatchObject({ account_ref: 'cus_1', subscription_ref: 'sub_1', provider_status: 'paid', due_at: null, total_minor: 0, currency: null });
    // The older top-level link is still accepted (dual-shape fallback, kept).
    expect(wireInvoiceState({ id: 'in_4', customer: 'cus_1', subscription: 'sub_9' })).toMatchObject({ subscription_ref: 'sub_9' });
    // Missing or malformed fields fail to null / 0, never to a guess.
    expect(wireInvoiceState({ id: 'in_3', amount_due: 'x', created: -1 })).toMatchObject({ subscription_ref: null, amount_due_minor: 0, created_at: null, account_ref: '' });
  });

  it('C3-W-2 a Stripe portal configuration becomes Aramo facts (the account-details feature is not mapped)', () => {
    const c = wirePortalConfigurationState(STRIPE_PORTAL_CONFIGURATION);
    expect(c).toEqual({
      configuration_ref: 'bpc_terms',
      active: true,
      is_default: false,
      live: false,
      invoice_history_enabled: true,
      payment_method_update_enabled: true,
      subscription_cancel_enabled: true,
      subscription_cancel_mode: 'at_period_end',
      subscription_update_enabled: false,
    });
    expect(wirePortalConfigurationState({ id: 'bpc_x' })).toMatchObject({ active: false, invoice_history_enabled: false, subscription_cancel_mode: null });
  });

  it('C3-W-3 read paths: invoices are listed by subscription (never by account), limit clamped 1..100; list data filtered to objects', () => {
    expect(wireInvoiceListPath('sub_1', 12)).toBe('/v1/invoices?subscription=sub_1&limit=12');
    expect(wireInvoiceListPath('sub_1', 0)).toBe('/v1/invoices?subscription=sub_1&limit=1');
    expect(wireInvoiceListPath('sub_1', 500)).toBe('/v1/invoices?subscription=sub_1&limit=100');
    expect(wireInvoiceListPath('sub_1', 3)).not.toContain('customer');
    expect(wirePortalConfigurationPath('bpc/../x')).toBe('/v1/billing_portal/configurations/bpc%2F..%2Fx');
    expect(wireListData({ data: [{ id: 'a' }, null, 7] })).toEqual([{ id: 'a' }]);
    expect(wireListData({})).toEqual([]);
  });
});

describe('CCP-C3 StripeBillingReadAdapter (GET-only) against a local stand-in', () => {
  const env = { ...process.env };
  type Seen = { method: string; path: string; body: unknown; headers: Record<string, string> };
  let seen: Seen[] = [];
  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });
  function standIn(routes: Record<string, { status?: number; json: unknown }>): void {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_local';
    process.env['STRIPE_API_BASE'] = 'http://stripe.test';
    seen = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      seen.push({ method: String(init.method), path: `${u.pathname}${u.search}`, body: init.body, headers: init.headers as Record<string, string> });
      const r = routes[u.pathname] ?? { status: 404, json: { error: { message: 'No such object' } } };
      return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
    }));
  }

  it('C3-W-4 every provider request is GET with no body and no idempotency key; results are translated', async () => {
    standIn({
      '/v1/subscriptions/sub_1': { json: { id: 'sub_1', status: 'past_due', customer: { id: 'cus_1', address: { country: 'US' } }, metadata: { tenant_id: 't1' }, items: { data: [{ id: 'si_1', quantity: 1, current_period_start: 10, current_period_end: 20 }] } } },
      '/v1/invoices': { json: { object: 'list', data: [STRIPE_INVOICE, { ...STRIPE_INVOICE, id: 'in_0', status: 'paid', amount_remaining: 0 }] } },
      '/v1/billing_portal/configurations/bpc_terms': { json: STRIPE_PORTAL_CONFIGURATION },
    });
    const a = new StripeBillingReadAdapter();
    expect(a.isConfigured()).toBe(true);
    expect(a.mode()).toBe('test');
    expect(await a.retrieveSubscription('sub_1')).toMatchObject({ subscription_ref: 'sub_1', account_ref: 'cus_1', provider_status: 'past_due', tenant_id: 't1' });
    const invoices = await a.listSubscriptionInvoices('sub_1', 5);
    expect(invoices.map((i) => [i.provider, i.invoice_ref, i.account_ref, i.provider_status])).toEqual([
      ['STRIPE', 'in_1', 'cus_1', 'open'],
      ['STRIPE', 'in_0', 'cus_1', 'paid'],
    ]);
    expect(await a.retrievePortalConfiguration('bpc_terms')).toMatchObject({ provider: 'STRIPE', configuration_ref: 'bpc_terms', active: true, subscription_cancel_mode: 'at_period_end' });
    expect(seen.map((r) => r.path)).toEqual(['/v1/subscriptions/sub_1?expand%5B%5D=customer', '/v1/invoices?subscription=sub_1&limit=5', '/v1/billing_portal/configurations/bpc_terms']);
    for (const r of seen) {
      expect(r.method).toBe('GET');
      expect(r.body).toBeUndefined();
      expect(Object.keys(r.headers).map((h) => h.toLowerCase())).not.toContain('idempotency-key');
      expect(Object.keys(r.headers).map((h) => h.toLowerCase())).not.toContain('content-type');
    }
  });

  it('C3-W-5 a missing portal configuration is null, a missing invoice list is empty; refusals, 429 and 5xx are typed; no key = unconfigured', async () => {
    standIn({ '/v1/subscriptions/sub_busy': { status: 429, json: { error: { message: 'Too many' } } }, '/v1/subscriptions/sub_bad': { status: 400, json: { error: { message: 'bad' } } } });
    const a = new StripeBillingReadAdapter();
    expect(await a.retrievePortalConfiguration('bpc_missing')).toBeNull();
    expect(await a.listSubscriptionInvoices('sub_missing', 3)).toEqual([]);
    await expect(a.retrieveSubscription('sub_missing')).rejects.toMatchObject({ name: 'BillingProviderUnavailableError', retryable: false });
    await expect(a.retrieveSubscription('sub_busy')).rejects.toMatchObject({ retryable: true });
    await expect(a.retrieveSubscription('sub_bad')).rejects.toMatchObject({ retryable: false });
    expect(seen.every((r) => r.method === 'GET')).toBe(true);
    delete process.env['STRIPE_SECRET_KEY'];
    expect(a.isConfigured()).toBe(false);
    await expect(a.retrievePortalConfiguration('bpc_terms')).rejects.toMatchObject({ name: 'BillingProviderUnavailableError' });
    process.env['STRIPE_SECRET_KEY'] = 'rk_live_x';
    expect(a.mode()).toBe('live');
  });
});

// CCP-C4 — the refund wire path against a stubbed fetch (no network; a sk_test_ placeholder). Kept
// here because the invoice fixtures are Stripe-shaped (C4-U-11, cited by CCP-C4-acceptance.md).
describe('CCP-C4 Stripe refund wire (stubbed fetch)', () => {
  const U = '019a0000-0000-7000-8000-0000000c4001';
  const env = { ...process.env };
  let calls: { method: string; url: string; body: string | undefined; idem: string | undefined }[] = [];
  let replies: Array<{ status: number; json: unknown }> = [];
  const c4 = new StripeBillingProvider();
  beforeEach(() => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_c4_placeholder';
    process.env['STRIPE_API_BASE'] = 'http://stripe.c4.invalid';
    calls = [];
    replies = [];
    vi.stubGlobal('fetch', async (url: string, init: { method: string; body?: string; headers: Record<string, string> }) => {
      calls.push({ method: init.method, url, body: init.body, idem: init.headers['idempotency-key'] });
      const r = replies.shift() ?? { status: 200, json: {} };
      return { ok: r.status < 400, status: r.status, json: async () => r.json } as unknown as Response;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...env };
  });

  // Stripe API Upgrade directive v1.0 B-1 — the invoice names no payment intent itself; the payment is
  // read from its expanded `payments` list (InvoicePayment.payment of type payment_intent).
  const pays = (...p: Array<{ pi: unknown; status?: string; type?: string }>) => ({
    object: 'list',
    data: p.map((x, i) => ({ id: `inpay_${i}`, object: 'invoice_payment', status: x.status ?? 'paid', payment: { type: x.type ?? 'payment_intent', payment_intent: x.pi } })),
    has_more: false,
  });

  it('C4-U-13 wireInvoicePayment reads the paying account and the payment intents of the invoice payments', () => {
    expect(wireInvoiceQuery()).toBe('expand%5B%5D=payments');
    expect(wireInvoicePayment({ customer: 'cus_1', payments: pays({ pi: { id: 'pi_1', object: 'payment_intent' } }), currency: 'usd', amount_paid: 900 })).toEqual({
      account_ref: 'cus_1',
      payment_refs: ['pi_1'],
      paid_payment_refs: ['pi_1'],
      payments_complete: true,
      currency: 'usd',
      amount_paid_minor: 900,
    });
    // Two attempts with the same intent are one payment; another payment type is not a payment intent.
    expect(wireInvoicePayment({ customer: 'cus_1', payments: pays({ pi: 'pi_1', status: 'canceled' }, { pi: 'pi_1' }, { pi: 'x', type: 'out_of_band_payment' }) })).toMatchObject({ payment_refs: ['pi_1'], paid_payment_refs: ['pi_1'] });
    // No payments (an unpaid invoice), and the removed top-level field is not read.
    expect(wireInvoicePayment({ customer: 'cus_1', payment_intent: 'pi_old', payments: pays() })).toMatchObject({ payment_refs: [], payments_complete: true });
    expect(wireInvoicePayment({ customer: 'cus_1', payments: { ...pays({ pi: 'pi_1' }), has_more: true } })).toMatchObject({ payment_refs: ['pi_1'], payments_complete: false });
  });

  it('B-1 the payment a refund draws on: none → null; one → it; several → the single paid one; otherwise, or an incomplete list, fails closed (non-retryable)', () => {
    expect(stripeInvoicePaymentRef(wireInvoicePayment({ payments: pays() }))).toBeNull();
    expect(stripeInvoicePaymentRef(wireInvoicePayment({ payments: pays({ pi: 'pi_1', status: 'open' }) }))).toBe('pi_1');
    expect(stripeInvoicePaymentRef(wireInvoicePayment({ payments: pays({ pi: 'pi_0', status: 'canceled' }, { pi: 'pi_1', status: 'paid' }) }))).toBe('pi_1');
    expect(() => stripeInvoicePaymentRef(wireInvoicePayment({ payments: pays({ pi: 'pi_0', status: 'paid' }, { pi: 'pi_1', status: 'paid' }) }))).toThrow(/ambiguous/);
    expect(() => stripeInvoicePaymentRef(wireInvoicePayment({ payments: pays({ pi: 'pi_0', status: 'open' }, { pi: 'pi_1', status: 'open' }) }))).toThrow(/ambiguous/);
    expect(() => stripeInvoicePaymentRef(wireInvoicePayment({ payments: { ...pays({ pi: 'pi_1' }), has_more: true } }))).toThrow(/incomplete/);
    try {
      stripeInvoicePaymentRef(wireInvoicePayment({ payments: pays({ pi: 'pi_0' }, { pi: 'pi_1' }) }));
    } catch (e) {
      expect(e).toMatchObject({ name: 'BillingProviderUnavailableError', retryable: false });
    }
  });

  it('C4-U-11 refund: the invoice is read first (payments expanded) and must have been paid from the tenant account; then ONE keyed refund POST on its payment', async () => {
    const r = adjustmentRequestOf({ id: U, command_kind: 'REFUND_CREATE', tenant_id: 'ten-1', target_ref: 'in_1', params: { subscription_id: U, amount_minor: 4_000, currency: 'USD', account_ref: 'acct_1' } });
    replies.push({ status: 200, json: { id: 'in_1', customer: 'acct_other', payments: pays({ pi: 'pi_1' }) } });
    await expect(c4.executeAdjustment(r, 'k')).rejects.toMatchObject({ retryable: false });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(calls[0]?.url).toMatch(/\/v1\/invoices\/in_1\?expand%5B%5D=payments$/);
    // No payment on the invoice: refused, nothing posted.
    replies.push({ status: 200, json: { id: 'in_1', customer: 'acct_1', payments: pays() } });
    await expect(c4.executeAdjustment(r, 'k')).rejects.toMatchObject({ retryable: false, detail: expect.stringMatching(/no payment/) });
    // Two paid payment intents: ambiguous, refused, nothing posted.
    replies.push({ status: 200, json: { id: 'in_1', customer: 'acct_1', payments: pays({ pi: 'pi_1' }, { pi: 'pi_2' }) } });
    await expect(c4.executeAdjustment(r, 'k')).rejects.toMatchObject({ retryable: false, detail: expect.stringMatching(/ambiguous/) });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    replies.push({ status: 200, json: { id: 'in_1', customer: 'acct_1', payments: pays({ pi: 'pi_0', status: 'canceled' }, { pi: 'pi_1' }) } }, { status: 200, json: { id: 're_1', status: 'pending' } });
    expect(await c4.executeAdjustment(r, 'k')).toEqual({ object_ref: 're_1' });
    const post = calls.filter((c) => c.method === 'POST');
    expect(post).toHaveLength(1);
    expect(post[0]?.url).toMatch(/\/v1\/refunds$/);
    expect(new URLSearchParams(post[0]?.body).get('payment_intent')).toBe('pi_1');
    expect(new URLSearchParams(post[0]?.body).get('amount')).toBe('4000');
    // a pending refund is not yet the effect (pending until the refund succeeds)
    // CCP-C4-R: the read is the payment's whole picture (invoice, then every refund of its payment).
    replies.push({ status: 200, json: { id: 'in_1', customer: 'acct_1', payments: pays({ pi: 'pi_1' }), amount_paid: 10_000, currency: 'usd' } }, { status: 200, json: { data: [{ id: 're_0', status: 'succeeded', amount: 1_000, metadata: {} }, { id: 're_1', status: 'pending', amount: 4_000, metadata: { aramo_command_id: U } }] } });
    expect(await c4.readAdjustmentEffect(r, 're_1')).toMatchObject({ present: false, provider_status: 'pending', object_ref: 're_1', observed_amount_minor: 4_000, refundable_remainder_minor: 5_000, payment_currency: 'usd' });
  });

  it('B-1 the payment picture (GET only): the invoice with its payments expanded, then every refund and dispute of its payment intent; no payment → no refund / dispute reads', async () => {
    replies.push(
      { status: 200, json: { id: 'in_1', customer: 'acct_1', payments: pays({ pi: { id: 'pi_7' } }), amount_paid: 4_900, currency: 'usd' } },
      { status: 200, json: { data: [{ id: 're_1', status: 'succeeded', amount: 900, metadata: { aramo_command_id: U } }], has_more: false } },
      { status: 200, json: { data: [{ id: 'dp_1', status: 'needs_response', amount: 4_000 }], has_more: false } },
    );
    const pic = await c4.readPaymentPicture('in_1');
    expect(pic).toMatchObject({ invoice_ref: 'in_1', account_ref: 'acct_1', payment_ref: 'pi_7', currency: 'usd', captured_minor: 4_900, complete: true, live: false });
    expect(pic.refunds).toEqual([{ object_ref: 're_1', amount_minor: 900, status: 'succeeded', command_id: U }]);
    expect(pic.disputes).toEqual([{ object_ref: 'dp_1', amount_minor: 4_000, status: 'needs_response' }]);
    expect(calls.map((c) => [c.method, c.url.replace('http://stripe.c4.invalid', '')])).toEqual([
      ['GET', '/v1/invoices/in_1?expand%5B%5D=payments'],
      ['GET', '/v1/refunds?payment_intent=pi_7&limit=100'],
      ['GET', '/v1/disputes?payment_intent=pi_7&limit=100'],
    ]);
    calls = [];
    replies.push({ status: 200, json: { id: 'in_2', customer: 'acct_1', payments: pays(), amount_paid: 0, currency: 'usd' } });
    expect(await c4.readPaymentPicture('in_2')).toMatchObject({ payment_ref: null, refunds: [], disputes: [], complete: true });
    expect(calls).toHaveLength(1);
    // Ambiguous (two paid payment intents): the read fails closed, nothing further is read.
    calls = [];
    replies.push({ status: 200, json: { id: 'in_3', customer: 'acct_1', payments: pays({ pi: 'pi_1' }, { pi: 'pi_2' }) } });
    await expect(c4.readPaymentPicture('in_3')).rejects.toMatchObject({ retryable: false });
    expect(calls).toHaveLength(1);
  });

});
