import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BillingProviderUnavailableError, BillingWebhookSignatureError, isWebBillingProvider, WEB_BILLING_PROVIDERS } from '../lib/billing/billing-provider.port.js';
import { BILLING_GATEWAY_REGISTRY, StaticBillingGatewayRegistry, UnboundBillingGatewayError } from '../lib/billing/gateway-registry.js';
import {
  RAZORPAY_STATUS_MAP,
  RAZORPAY_SUBSCRIPTION_TOTAL_COUNT,
  RazorpayBillingProvider,
  razorpayApiBase,
  razorpayCheckoutSessionState,
  razorpayCredentials,
  razorpayEventId,
  razorpayProviderStatus,
  razorpaySubscriptionState,
} from '../lib/billing/razorpay-billing.provider.js';
import { StripeBillingProvider } from '../lib/billing/stripe-billing.provider.js';
import { mapProviderStatus } from '../lib/billing/subscription-lifecycle.service.js';

// India Billing Regions + Razorpay (Implementation Directive v1.0 LOCKED §4.3, §4.5, §6 G-2) — the
// Razorpay adapter against a fake fetch (no network, no real key): credentials and G-2, checkout
// (hosted authorization link), cancel, seats (quantity), retrieve, the status table, the webhook
// signature (good / bad / tampered / missing), and the gateway registry.

interface Req {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

function fakeFetch(reply: (r: Req) => { status?: number; json: unknown } = () => ({ json: { id: 'sub_1', short_url: 'https://rzp.io/i/abc', status: 'created' } })) {
  const calls: Req[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    const r: Req = { method: String(init?.method), url, headers: (init?.headers as Record<string, string>) ?? {}, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null };
    calls.push(r);
    const out = reply(r);
    return new Response(JSON.stringify(out.json), { status: out.status ?? 200 });
  };
  return { calls, fn };
}

const ENV = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_API_BASE'];

describe('India Billing — Razorpay adapter', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env['RAZORPAY_KEY_ID'] = 'rzp_test_k1';
    process.env['RAZORPAY_KEY_SECRET'] = 'sec_1';
    process.env['RAZORPAY_WEBHOOK_SECRET'] = 'whsec_rzp';
    process.env['RAZORPAY_API_BASE'] = 'http://rzp.test/';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  describe('credentials (G-2)', () => {
    it('configured only with all three secrets; test / live mode from the key id', () => {
      const p = new RazorpayBillingProvider();
      expect(p.provider).toBe('RAZORPAY');
      expect(p.isConfigured()).toBe(true);
      expect(p.mode()).toBe('test');
      for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) {
        const v = process.env[k];
        process.env[k] = '  ';
        expect(new RazorpayBillingProvider().isConfigured(), k).toBe(false);
        process.env[k] = v;
      }
      process.env['RAZORPAY_KEY_ID'] = 'rzp_live_x';
      expect(p.mode()).toBe('live');
    });
    it('the readers: credentials trimmed, API base defaulted and stripped of a trailing slash', () => {
      expect(razorpayCredentials()).toEqual({ key_id: 'rzp_test_k1', key_secret: 'sec_1' });
      expect(razorpayApiBase()).toBe('http://rzp.test');
      delete process.env['RAZORPAY_API_BASE'];
      expect(razorpayApiBase()).toBe('https://api.razorpay.com');
      for (const k of ENV) delete process.env[k];
      expect(razorpayCredentials()).toBeUndefined();
    });
    it('no key: a provider call is refused before any request', async () => {
      delete process.env['RAZORPAY_KEY_SECRET'];
      const f = fakeFetch();
      await expect(new RazorpayBillingProvider(f.fn).retrieveSubscription('sub_1')).rejects.toBeInstanceOf(BillingProviderUnavailableError);
      expect(f.calls).toHaveLength(0);
    });
  });

  describe('checkout — the hosted authorization link', () => {
    it('creates a subscription on the pinned plan (120 cycles, quantity, notify, Aramo notes) with Basic auth; the link is the redirect', async () => {
      const f = fakeFetch();
      const out = await new RazorpayBillingProvider(f.fn).createCheckoutSession({
        intent_id: 'i-1', tenant_id: 't-1', user_id: 'u-1', user_email: 'o@acme.test', price_ref: 'plan_X', account_ref: null,
        success_url: 'https://e/ok', cancel_url: 'https://e/no', collect_address: true, disclosure: 'Renews monthly',
      });
      expect(out).toEqual({ session_ref: 'sub_1', url: 'https://rzp.io/i/abc' });
      expect(f.calls).toHaveLength(1);
      const c = f.calls[0] as Req;
      expect(c.method).toBe('POST');
      expect(c.url).toBe('http://rzp.test/v1/subscriptions');
      expect(c.headers['authorization']).toBe(`Basic ${Buffer.from('rzp_test_k1:sec_1').toString('base64')}`);
      expect(c.headers['content-type']).toBe('application/json');
      expect(c.body).toMatchObject({ plan_id: 'plan_X', total_count: RAZORPAY_SUBSCRIPTION_TOTAL_COUNT, quantity: 1, notes: { tenant_id: 't-1', intent_id: 'i-1', user_id: 'u-1' } });
      expect(RAZORPAY_SUBSCRIPTION_TOTAL_COUNT).toBe(120);
      // Razorpay has no return URL, address collection or submit text: none is sent.
      expect(JSON.stringify(c.body)).not.toMatch(/https:\/\/e\/|Renews|address/);
    });
    it('a per-seat checkout sends its quantity; an invalid quantity is refused before any request', async () => {
      const f = fakeFetch();
      const p = new RazorpayBillingProvider(f.fn);
      const req = { intent_id: 'i', tenant_id: 't', user_id: 'u', user_email: 'e', price_ref: 'plan', account_ref: null, success_url: 's', cancel_url: 'c' };
      await p.createCheckoutSession({ ...req, quantity: 4 });
      expect(f.calls[0]?.body?.['quantity']).toBe(4);
      await expect(p.createCheckoutSession({ ...req, quantity: 0 })).rejects.toMatchObject({ retryable: false });
      expect(f.calls).toHaveLength(1);
    });
    it('a reply without id / link is a provider failure; a 4xx is not retryable, a 5xx / 429 / network failure is', async () => {
      const req = { intent_id: 'i', tenant_id: 't', user_id: 'u', user_email: 'e', price_ref: 'plan', account_ref: null, success_url: 's', cancel_url: 'c' };
      await expect(new RazorpayBillingProvider(fakeFetch(() => ({ json: { id: 'sub_1' } })).fn).createCheckoutSession(req)).rejects.toBeInstanceOf(BillingProviderUnavailableError);
      await expect(new RazorpayBillingProvider(fakeFetch(() => ({ status: 400, json: { error: { description: 'bad plan' } } })).fn).createCheckoutSession(req)).rejects.toMatchObject({ retryable: false, detail: expect.stringContaining('bad plan') });
      await expect(new RazorpayBillingProvider(fakeFetch(() => ({ status: 503, json: {} })).fn).createCheckoutSession(req)).rejects.toMatchObject({ retryable: true });
      await expect(new RazorpayBillingProvider(fakeFetch(() => ({ status: 429, json: {} })).fn).createCheckoutSession(req)).rejects.toMatchObject({ retryable: true });
      await expect(new RazorpayBillingProvider(async () => { throw new Error('ECONNRESET'); }).createCheckoutSession(req)).rejects.toMatchObject({ retryable: true });
    });
    it('the key secret never appears in an error', async () => {
      const req = { intent_id: 'i', tenant_id: 't', user_id: 'u', user_email: 'e', price_ref: 'plan', account_ref: null, success_url: 's', cancel_url: 'c' };
      const err = await new RazorpayBillingProvider(fakeFetch(() => ({ status: 401, json: { error: { description: 'Authentication failed' } } })).fn).createCheckoutSession(req).catch((e: Error) => e);
      expect(String((err as Error).message)).not.toContain('sec_1');
    });
  });

  describe('billing account, portal', () => {
    it('creates (POST, fail_existing 0, tenant note) or updates (PUT) the account; no address or registration field is sent', async () => {
      const f = fakeFetch(() => ({ json: { id: 'acct_1' } }));
      const p = new RazorpayBillingProvider(f.fn);
      const details = { tenant_id: 't-1', legal_name: 'Acme Pvt Ltd', billing_email: 'b@acme.test', address: { line1: '1 MG Rd', line2: null, city: 'Bengaluru', state: 'KA', postal_code: '560001', country: 'IN' } };
      expect(await p.upsertBillingAccount(null, details)).toBe('acct_1');
      expect(await p.upsertBillingAccount('acct_1', details)).toBe('acct_1');
      expect(f.calls.map((c) => c.method)).toEqual(['POST', 'PUT']);
      expect(f.calls[0]?.body).toEqual({ name: 'Acme Pvt Ltd', email: 'b@acme.test', fail_existing: '0', notes: { tenant_id: 't-1' } });
      // The paths are the wire file's (razorpay-wire.spec.ts pins them): the update names the account.
      expect(f.calls[1]?.url).toBe(`${f.calls[0]?.url}/acct_1`);
      expect(JSON.stringify(f.calls.map((c) => c.body))).not.toMatch(/MG Rd|560001|gst/i);
    });
    it('no hosted portal: the Aramo return URL is the manage page (no provider call)', async () => {
      const f = fakeFetch();
      expect(await new RazorpayBillingProvider(f.fn).createPortalSession('acct_1', 'https://sign.aramo.ai/sign/settings/billing')).toEqual({ url: 'https://sign.aramo.ai/sign/settings/billing' });
      expect(f.calls).toHaveLength(0);
    });
  });

  describe('retrieve, cancel, seats, checkout session', () => {
    const SUB = { id: 'sub_9', status: 'active', plan_id: 'plan_9', current_start: 1_800_000_000, current_end: 1_802_592_000, quantity: 3, notes: { tenant_id: 't-9', intent_id: 'i-9' } };
    it('retrieve: GET the subscription → the provider state (period, plan as the price, notes, quantity; no account country)', async () => {
      const f = fakeFetch(() => ({ json: SUB }));
      const s = await new RazorpayBillingProvider(f.fn).retrieveSubscription('sub_9');
      expect(f.calls[0]).toMatchObject({ method: 'GET', url: 'http://rzp.test/v1/subscriptions/sub_9', body: null });
      expect(s).toEqual({
        provider: 'RAZORPAY', subscription_ref: 'sub_9', account_ref: '', provider_status: 'active',
        current_period_start: new Date(1_800_000_000_000), current_period_end: new Date(1_802_592_000_000), cancel_at_period_end: false,
        price_ref: 'plan_9', tenant_id: 't-9', intent_id: 'i-9', account_country: null, item_ref: null, quantity: 3,
      });
      expect(razorpaySubscriptionState({ ...SUB, cancel_at_cycle_end: 1 }).cancel_at_period_end).toBe(true);
      expect(razorpaySubscriptionState({ ...SUB, notes: [], quantity: 0, current_start: null }).tenant_id).toBeNull();
    });
    it('cancel: at the cycle end (1) or now (0), by the cancel endpoint', async () => {
      const f = fakeFetch(() => ({ json: { id: 'sub_9', status: 'cancelled' } }));
      const p = new RazorpayBillingProvider(f.fn);
      await p.cancelSubscription('sub_9', { at_period_end: true });
      await p.cancelSubscription('sub_9', { at_period_end: false });
      await p.expireCheckoutSession('sub_8');
      expect(f.calls.map((c) => [c.method, c.url, c.body])).toEqual([
        ['POST', 'http://rzp.test/v1/subscriptions/sub_9/cancel', { cancel_at_cycle_end: 1 }],
        ['POST', 'http://rzp.test/v1/subscriptions/sub_9/cancel', { cancel_at_cycle_end: 0 }],
        ['POST', 'http://rzp.test/v1/subscriptions/sub_8/cancel', { cancel_at_cycle_end: 0 }],
      ]);
    });
    it('seats: PATCH quantity (increase now, decrease / restore at the cycle end), then re-read', async () => {
      const f = fakeFetch(() => ({ json: SUB }));
      const p = new RazorpayBillingProvider(f.fn);
      expect((await p.updateSubscriptionQuantity('sub_9', 3, 'create_prorations')).quantity).toBe(3);
      await p.updateSubscriptionQuantity('sub_9', 2, 'none');
      expect(f.calls.map((c) => [c.method, c.body])).toEqual([
        ['PATCH', { quantity: 3, schedule_change_at: 'now' }],
        ['GET', null],
        ['PATCH', { quantity: 2, schedule_change_at: 'cycle_end' }],
        ['GET', null],
      ]);
      await expect(p.updateSubscriptionQuantity('sub_9', 0, 'none')).rejects.toMatchObject({ retryable: false });
      expect(f.calls).toHaveLength(4);
    });
    it('checkout session view: created = open; expired or cancelled unpaid = expired; otherwise complete', async () => {
      expect(razorpayCheckoutSessionState({ ...SUB, status: 'created' }).status).toBe('open');
      expect(razorpayCheckoutSessionState({ ...SUB, status: 'expired' }).status).toBe('expired');
      expect(razorpayCheckoutSessionState({ ...SUB, status: 'cancelled', paid_count: 0 }).status).toBe('expired');
      expect(razorpayCheckoutSessionState({ ...SUB, status: 'cancelled', paid_count: 2 }).status).toBe('complete');
      expect(razorpayCheckoutSessionState({ ...SUB, status: 'active', paid_count: 1 })).toEqual({ provider: 'RAZORPAY', session_ref: 'sub_9', status: 'complete', tenant_id: 't-9', intent_id: 'i-9' });
      const f = fakeFetch(() => ({ json: { ...SUB, status: 'created' } }));
      expect((await new RazorpayBillingProvider(f.fn).retrieveCheckoutSession('sub_9')).status).toBe('open');
    });
  });

  describe('status table → mapProviderStatus', () => {
    it('every Razorpay state lands on the intended Aramo status (unknown fails closed to INCOMPLETE)', () => {
      const aramo = (s: string) => mapProviderStatus(razorpayProviderStatus(s));
      expect(aramo('created')).toEqual({ status: 'INCOMPLETE', grace: false, ends: false });
      expect(aramo('authenticated')).toEqual({ status: 'INCOMPLETE', grace: false, ends: false });
      expect(aramo('active')).toEqual({ status: 'ACTIVE', grace: false, ends: false });
      expect(aramo('pending')).toEqual({ status: 'PAST_DUE', grace: true, ends: false });
      expect(aramo('halted')).toEqual({ status: 'PAST_DUE', grace: false, ends: false });
      expect(aramo('paused')).toEqual({ status: 'PAST_DUE', grace: false, ends: false });
      expect(aramo('cancelled')).toEqual({ status: 'CANCELED', grace: false, ends: true });
      expect(aramo('completed')).toEqual({ status: 'CANCELED', grace: false, ends: true });
      expect(aramo('expired')).toEqual({ status: 'CANCELED', grace: false, ends: true });
      expect(aramo('something_new')).toEqual({ status: 'INCOMPLETE', grace: false, ends: false });
      expect(razorpayProviderStatus(undefined)).toBe('incomplete');
      expect(Object.keys(RAZORPAY_STATUS_MAP).sort()).toEqual(['active', 'authenticated', 'cancelled', 'completed', 'created', 'expired', 'halted', 'paused', 'pending']);
    });
  });

  describe('webhook signature (X-Razorpay-Signature = hex HMAC-SHA256 of the raw body)', () => {
    const sign = (body: string, secret = 'whsec_rzp') => createHmac('sha256', secret).update(body).digest('hex');
    const evt = (event: string, payload: Record<string, unknown>) => JSON.stringify({ entity: 'event', event, contains: Object.keys(payload), payload, created_at: 1_800_000_100 });
    const body = evt('subscription.charged', { subscription: { entity: { id: 'sub_9', status: 'active' } }, payment: { entity: { id: 'pay_1' } } });

    it('good: the verified envelope names the subscription, the provider and the header event id', () => {
      const p = new RazorpayBillingProvider();
      expect(p.verifyWebhook(Buffer.from(body), sign(body), 0, { event_id: 'evt_abc' })).toEqual({
        provider: 'RAZORPAY', id: 'evt_abc', type: 'subscription.charged', created: new Date(1_800_000_100_000), subscription_ref: 'sub_9',
      });
      // Upper-case hex is accepted (compared case-insensitively, in constant time).
      expect(p.verifyWebhook(Buffer.from(body), sign(body).toUpperCase(), 0).subscription_ref).toBe('sub_9');
    });
    it('no event-id header: a stable id from the payload (same delivery → same id; another event → another id)', () => {
      const p = new RazorpayBillingProvider();
      const a = p.verifyWebhook(Buffer.from(body), sign(body), 0).id;
      expect(a).toMatch(/^rzp_evt_[0-9a-f]{32}$/);
      expect(p.verifyWebhook(Buffer.from(body), sign(body), 0, { event_id: undefined }).id).toBe(a);
      const other = evt('subscription.halted', { subscription: { entity: { id: 'sub_9' } } });
      expect(p.verifyWebhook(Buffer.from(other), sign(other), 0).id).not.toBe(a);
      expect(razorpayEventId('bad id with spaces', 'sub_9', 'x', 1)).toMatch(/^rzp_evt_/);
    });
    it('a payment event without a subscription names its payment object; one linked to a subscription names that', () => {
      const p = new RazorpayBillingProvider();
      const failed = evt('payment.failed', { payment: { entity: { id: 'pay_2' } } });
      expect(p.verifyWebhook(Buffer.from(failed), sign(failed), 0)).toMatchObject({ subscription_ref: null, object_ref: 'pay_2' });
      const linked = evt('payment.failed', { payment: { entity: { id: 'pay_3', subscription_id: 'sub_7' } } });
      expect(p.verifyWebhook(Buffer.from(linked), sign(linked), 0)).toMatchObject({ subscription_ref: 'sub_7' });
    });
    it('bad, tampered, missing, malformed and secret-less deliveries are rejected before parsing', () => {
      const p = new RazorpayBillingProvider();
      const reason = (raw: string, sig: string | undefined) => {
        try {
          p.verifyWebhook(Buffer.from(raw), sig, 0);
          return 'accepted';
        } catch (e) {
          return e instanceof BillingWebhookSignatureError ? e.reason : 'other';
        }
      };
      expect(reason(body, sign(body, 'wrong-secret'))).toBe('BAD_SIGNATURE');
      expect(reason(body.replace('sub_9', 'sub_X'), sign(body))).toBe('BAD_SIGNATURE');
      expect(reason(body, undefined)).toBe('MISSING');
      expect(reason(body, '')).toBe('MISSING');
      expect(reason(body, 'not-hex')).toBe('MALFORMED');
      expect(reason('not json', sign('not json'))).toBe('MALFORMED');
      expect(reason('{"event":"x"}', sign('{"event":"x"}'))).toBe('MALFORMED');
      process.env['RAZORPAY_WEBHOOK_SECRET'] = '';
      expect(reason(body, sign(body))).toBe('NO_SECRET');
    });
  });
});

describe('India Billing §4.3 — the gateway registry', () => {
  it('resolves each web gateway; Stripe is exactly the bound instance; an unbound key throws', () => {
    const stripe = new StripeBillingProvider();
    const razorpay = new RazorpayBillingProvider();
    const reg = new StaticBillingGatewayRegistry({ STRIPE: { billing: stripe, commands: stripe, seats: stripe }, RAZORPAY: { billing: razorpay, commands: razorpay, seats: razorpay } });
    expect(reg.billing('STRIPE')).toBe(stripe);
    expect(reg.commands('STRIPE')).toBe(stripe);
    expect(reg.seats('STRIPE')).toBe(stripe);
    expect(reg.billing('RAZORPAY')).toBe(razorpay);
    expect(reg.commands('RAZORPAY')).toBe(razorpay);
    expect(reg.seats('RAZORPAY')).toBe(razorpay);
    const only = new StaticBillingGatewayRegistry({ STRIPE: { billing: stripe } });
    expect(() => only.billing('RAZORPAY')).toThrow(UnboundBillingGatewayError);
    expect(only.commands('RAZORPAY')).toBeNull();
    expect(only.seats('STRIPE')).toBeNull();
    expect(only.configured('RAZORPAY')).toBe(false);
    expect(typeof BILLING_GATEWAY_REGISTRY).toBe('symbol');
  });
  it('configured() follows the gateway (Razorpay dark without its credentials, G-2)', () => {
    const saved = { ...process.env };
    try {
      for (const k of ENV) delete process.env[k];
      const reg = new StaticBillingGatewayRegistry({ RAZORPAY: { billing: new RazorpayBillingProvider() } });
      expect(reg.configured('RAZORPAY')).toBe(false);
      Object.assign(process.env, { RAZORPAY_KEY_ID: 'rzp_test_1', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w' });
      expect(reg.configured('RAZORPAY')).toBe(true);
    } finally {
      process.env = { ...saved };
    }
  });
  it('a binding that reports another provider is refused at construction', () => {
    expect(() => new StaticBillingGatewayRegistry({ RAZORPAY: { billing: new StripeBillingProvider() } })).toThrow(/another provider/);
  });
  it('the web providers', () => {
    expect([...WEB_BILLING_PROVIDERS]).toEqual(['STRIPE', 'RAZORPAY']);
    expect(['STRIPE', 'RAZORPAY', 'APP_STORE', 'GOOGLE_PLAY', null, undefined, 'stripe'].map((p) => isWebBillingProvider(p))).toEqual([true, true, false, false, false, false, false]);
  });
});
