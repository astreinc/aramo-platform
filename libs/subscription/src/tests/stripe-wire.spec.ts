import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adjustmentRequestOf } from '../lib/billing/billing-provider-command.js';
import { StripeBillingProvider, stripeEventSubscriptionRef, stripeSubscriptionState } from '../lib/billing/stripe-billing.provider.js';
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
  wireInvoiceState,
  wireListData,
  wirePortalAccountParams,
  wirePortalConfigurationPath,
  wirePortalConfigurationState,
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

// CCP-C3 (PBD §5.2 row C3) — boundary CONTRACT tests for the read-through translation and the
// GET-only read adapter. The fixtures are Stripe-shaped (they carry Stripe's own account field),
// which is why they live in this exempt spec. Test IDs are cited by CCP-C3-acceptance.md.

const STRIPE_INVOICE = {
  id: 'in_1',
  object: 'invoice',
  number: 'ARAMO-0001',
  customer: 'cus_1',
  subscription: 'sub_1',
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
    // Newer API: the subscription sits under parent.subscription_details; the account may be expanded.
    const newer = wireInvoiceState({ id: 'in_2', status: 'paid', customer: { id: 'cus_1' }, parent: { subscription_details: { subscription: 'sub_1' } } });
    expect(newer).toMatchObject({ account_ref: 'cus_1', subscription_ref: 'sub_1', provider_status: 'paid', due_at: null, total_minor: 0, currency: null });
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
      '/v1/subscriptions/sub_1': { json: { id: 'sub_1', status: 'past_due', customer: { id: 'cus_1', address: { country: 'US' } }, metadata: { tenant_id: 't1' }, current_period_start: 10, current_period_end: 20 } },
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

  it('C4-U-13 wireInvoicePayment reads the paying account and the payment', () => {
    expect(wireInvoicePayment({ customer: 'cus_1', payment_intent: { id: 'pi_1' }, currency: 'usd', amount_paid: 900 })).toEqual({ account_ref: 'cus_1', payment_ref: 'pi_1', currency: 'usd', amount_paid_minor: 900 });
  });

  it('C4-U-11 refund: the invoice is read first and must have been paid from the tenant account; then ONE keyed refund POST on its payment', async () => {
    const r = adjustmentRequestOf({ id: U, command_kind: 'REFUND_CREATE', tenant_id: 'ten-1', target_ref: 'in_1', params: { subscription_id: U, amount_minor: 4_000, currency: 'USD', account_ref: 'acct_1' } });
    replies.push({ status: 200, json: { id: 'in_1', customer: 'acct_other', payment_intent: 'pi_1' } });
    await expect(c4.executeAdjustment(r, 'k')).rejects.toMatchObject({ retryable: false });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    replies.push({ status: 200, json: { id: 'in_1', customer: 'acct_1', payment_intent: 'pi_1' } }, { status: 200, json: { id: 're_1', status: 'pending' } });
    expect(await c4.executeAdjustment(r, 'k')).toEqual({ object_ref: 're_1' });
    const post = calls.filter((c) => c.method === 'POST');
    expect(post).toHaveLength(1);
    expect(post[0]?.url).toMatch(/\/v1\/refunds$/);
    expect(new URLSearchParams(post[0]?.body).get('payment_intent')).toBe('pi_1');
    expect(new URLSearchParams(post[0]?.body).get('amount')).toBe('4000');
    // a pending refund is not yet the effect (pending until the refund succeeds)
    replies.push({ status: 200, json: { id: 're_1', status: 'pending', amount: 4_000, metadata: { aramo_command_id: U } } });
    expect(await c4.readAdjustmentEffect(r, 're_1')).toMatchObject({ present: false, provider_status: 'pending' });
  });

});
