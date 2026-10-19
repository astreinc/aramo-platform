import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BillingWebhookSignatureError } from '../lib/billing/billing-provider.port.js';
import { StripeBillingProvider, stripeEventSubscriptionRef, verifyStripeSignature } from '../lib/billing/stripe-billing.provider.js';
import { mapProviderStatus, parsePlanPrices } from '../lib/billing/subscription-lifecycle.service.js';

// Aramo Sign launch — the Stripe adapter: webhook signatures (forged, stale,
// tampered), status mapping, price config, and the REST calls (against a local
// stand-in; no network, no real keys). Vendor-shaped payload translation is
// proven in stripe-wire.spec.ts (the vocabulary-exempt boundary spec).

const SECRET = 'whsec_test_only';
const sign = (body: string, t: number, secret = SECRET) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

describe('verifyStripeSignature', () => {
  const body = '{"id":"evt_1","type":"invoice.paid","created":1,"data":{"object":{"subscription":"sub_1"}}}';
  const now = 1_800_000_000;
  const reason = (fn: () => void) => {
    try {
      fn();
      return 'OK';
    } catch (e) {
      return (e as BillingWebhookSignatureError).reason;
    }
  };

  it('accepts a correctly signed, fresh payload', () => {
    expect(reason(() => verifyStripeSignature(Buffer.from(body), sign(body, now), SECRET, now))).toBe('OK');
  });
  it('accepts when any v1 signature matches (secret rotation)', () => {
    const h = `t=${now},v1=${'0'.repeat(64)},${sign(body, now).split(',')[1]}`;
    expect(reason(() => verifyStripeSignature(Buffer.from(body), h, SECRET, now))).toBe('OK');
  });
  it('rejects forged, tampered, stale, missing, malformed and unconfigured', () => {
    expect(reason(() => verifyStripeSignature(Buffer.from(body), sign(body, now, 'whsec_attacker'), SECRET, now))).toBe('BAD_SIGNATURE');
    expect(reason(() => verifyStripeSignature(Buffer.from(body.replace('sub_1', 'sub_2')), sign(body, now), SECRET, now))).toBe('BAD_SIGNATURE');
    expect(reason(() => verifyStripeSignature(Buffer.from(body), sign(body, now - 301), SECRET, now))).toBe('STALE');
    expect(reason(() => verifyStripeSignature(Buffer.from(body), undefined, SECRET, now))).toBe('MISSING');
    expect(reason(() => verifyStripeSignature(Buffer.from(body), 'v1=abc', SECRET, now))).toBe('MALFORMED');
    expect(reason(() => verifyStripeSignature(Buffer.from(body), sign(body, now), undefined, now))).toBe('NO_SECRET');
  });
});

describe('status + price mapping', () => {
  it('maps every provider status to the Aramo lifecycle', () => {
    expect(mapProviderStatus('active')).toEqual({ status: 'ACTIVE', grace: false, ends: false });
    expect(mapProviderStatus('trialing').status).toBe('TRIALING');
    expect(mapProviderStatus('past_due')).toEqual({ status: 'PAST_DUE', grace: true, ends: false });
    expect(mapProviderStatus('unpaid')).toEqual({ status: 'PAST_DUE', grace: false, ends: false });
    expect(mapProviderStatus('canceled')).toEqual({ status: 'CANCELED', grace: false, ends: true });
    expect(mapProviderStatus('incomplete_expired').ends).toBe(true);
    expect(mapProviderStatus('incomplete').status).toBe('INCOMPLETE');
    expect(mapProviderStatus('something-new').status).toBe('INCOMPLETE');
  });
  it('parses the operator price map and ignores junk', () => {
    expect([...parsePlanPrices(' aramo-sign-business-v1=price_A , bad, =x, y= ,b=price_B')]).toEqual([
      ['aramo-sign-business-v1', 'price_A'],
      ['b', 'price_B'],
    ]);
    expect(parsePlanPrices(undefined).size).toBe(0);
  });
});

describe('stripeEventSubscriptionRef', () => {
  it('resolves the subscription of checkout, subscription and invoice events only', () => {
    expect(stripeEventSubscriptionRef('checkout.session.completed', { mode: 'subscription', subscription: 'sub_1' })).toBe('sub_1');
    expect(stripeEventSubscriptionRef('checkout.session.completed', { mode: 'payment', subscription: 'sub_1' })).toBeNull();
    expect(stripeEventSubscriptionRef('invoice.payment_failed', { subscription: { id: 'sub_3' } })).toBe('sub_3');
    expect(stripeEventSubscriptionRef('invoice.paid', { parent: { subscription_details: { subscription: 'sub_4' } } })).toBe('sub_4');
    expect(stripeEventSubscriptionRef('charge.refunded', { id: 'ch_1' })).toBeNull();
  });
});

describe('StripeBillingProvider (local stand-in)', () => {
  let server: Server;
  const seen: { method: string; url: string; headers: Record<string, unknown>; body: string }[] = [];
  const env = { ...process.env };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/v1/checkout/sessions') return res.end(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' }));
        if (req.url === '/v1/billing_portal/sessions') return res.end(JSON.stringify({ url: 'https://billing.stripe.test/p' }));
        if (req.url === '/v1/subscriptions/sub_1') return res.end(JSON.stringify({ id: 'sub_1', status: 'past_due', current_period_start: 1, current_period_end: 2, items: { data: [] } }));
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: 'No such subscription' } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    process.env['STRIPE_API_BASE'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_local';
    process.env['STRIPE_WEBHOOK_SECRET'] = SECRET;
  });
  afterAll(() => {
    process.env = env;
    server.close();
  });

  it('creates a subscription checkout carrying the Aramo identifiers, idempotently keyed', async () => {
    const p = new StripeBillingProvider();
    expect(p.isConfigured()).toBe(true);
    const s = await p.createCheckoutSession({
      intent_id: 'i1', tenant_id: 't1', user_id: 'u1', user_email: 'o@acme.test', price_ref: 'price_A', account_ref: null,
      success_url: 'https://esign.test/ok', cancel_url: 'https://esign.test/no',
    });
    expect(s).toEqual({ session_ref: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });
    const req = seen.find((r) => r.url === '/v1/checkout/sessions')!;
    const params = new URLSearchParams(req.body);
    expect(params.get('mode')).toBe('subscription');
    expect(params.get('subscription_data[metadata][tenant_id]')).toBe('t1');
    expect(params.get('subscription_data[metadata][intent_id]')).toBe('i1');
    expect(req.headers['idempotency-key']).toBe('aramo-checkout-i1');
    expect(req.headers['authorization']).toBe('Bearer sk_test_local');
  });

  it('reports live mode only for live credentials (live charging is separately authorized)', () => {
    expect(new StripeBillingProvider().mode()).toBe('test');
    const k = process.env['STRIPE_SECRET_KEY'];
    process.env['STRIPE_SECRET_KEY'] = 'sk_live_x';
    expect(new StripeBillingProvider().mode()).toBe('live');
    process.env['STRIPE_SECRET_KEY'] = 'rk_live_x';
    expect(new StripeBillingProvider().mode()).toBe('live');
    process.env['STRIPE_SECRET_KEY'] = k;
  });

  it('opens a portal session and retrieves a subscription', async () => {
    const p = new StripeBillingProvider();
    expect(await p.createPortalSession('cus_1', 'https://esign.test/settings')).toEqual({ url: 'https://billing.stripe.test/p' });
    expect((await p.retrieveSubscription('sub_1')).provider_status).toBe('past_due');
  });

  it('surfaces provider errors as unavailable, and is unconfigured without keys', async () => {
    await expect(new StripeBillingProvider().retrieveSubscription('sub_x')).rejects.toThrow(/No such subscription/);
    delete process.env['STRIPE_SECRET_KEY'];
    expect(new StripeBillingProvider().isConfigured()).toBe(false);
    await expect(new StripeBillingProvider().retrieveSubscription('sub_1')).rejects.toThrow(/not configured/);
  });

  it('verifies, then parses, a webhook', () => {
    process.env['STRIPE_WEBHOOK_SECRET'] = SECRET;
    const body = JSON.stringify({ id: 'evt_9', type: 'invoice.paid', created: 5, data: { object: { subscription: 'sub_1' } } });
    const evt = new StripeBillingProvider().verifyWebhook(Buffer.from(body), sign(body, 1000), 1000);
    expect(evt).toEqual({ id: 'evt_9', type: 'invoice.paid', created: new Date(5000), subscription_ref: 'sub_1' });
    expect(() => new StripeBillingProvider().verifyWebhook(Buffer.from(body), sign(body, 1000, 'x'), 1000)).toThrow(BillingWebhookSignatureError);
  });
});
