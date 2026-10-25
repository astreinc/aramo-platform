import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BillingProviderUnavailableError } from '../lib/billing/billing-provider.port.js';
import {
  BILLING_COMMAND_STATES,
  BILLING_COMMAND_TRANSITIONS,
  billingCommandBackoffMs,
  billingCommandIdempotencyKey,
  canTransitionBillingCommand,
  subscriptionCancelConfirmed,
} from '../lib/billing/billing-provider-command.js';
import { StripeBillingProvider, stripeCheckoutSessionState, stripeEventCheckoutSessionRef } from '../lib/billing/stripe-billing.provider.js';

// CCP-C1 — the Stripe command port (cancel, expire, session read) against a LOCAL stand-in
// (127.0.0.1; a sk_test_ placeholder key; no network), the retryable / permanent error split, the
// checkout-session envelope, and the TS mirror of the DB command state machine. Test IDs are cited
// by doc/ccp/slices/CCP-C1-acceptance.md.

const SECRET = 'whsec_test_only';
const sign = (body: string, t: number) => `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}`;

describe('CCP-C1 command state machine (TS mirror of guard_billing_provider_command)', () => {
  it('C1-U-1 exactly 12 of the 36 state pairs are allowed; CONFIRMED is terminal; FAILED only → PENDING (retry) or CONFIRMED', () => {
    const pairs = BILLING_COMMAND_STATES.flatMap((f) => BILLING_COMMAND_STATES.map((t) => [f, t] as const)).filter(([f, t]) => canTransitionBillingCommand(f, t));
    expect(pairs.length).toBe(12);
    expect(BILLING_COMMAND_TRANSITIONS.CONFIRMED).toEqual([]);
    expect(BILLING_COMMAND_TRANSITIONS.FAILED).toEqual(['PENDING', 'CONFIRMED']);
    expect(BILLING_COMMAND_TRANSITIONS.PENDING_PROVIDER).toEqual(['CONFIRMED']);
    for (const s of BILLING_COMMAND_STATES) if (s !== 'CONFIRMED') expect(canTransitionBillingCommand(s, 'CONFIRMED')).toBe(true);
  });

  it('C1-U-2 the idempotency key is derived from the change request and the step (Conv. C-22)', () => {
    expect(billingCommandIdempotencyKey('0190c1c1-0000-7000-8000-000000000001', 'end_self_service')).toBe('aramo-ccp-0190c1c1-0000-7000-8000-000000000001-end_self_service');
  });

  it('C1-U-3 backoff doubles from 1 minute and caps at 6 hours', () => {
    expect([1, 2, 3, 4].map(billingCommandBackoffMs)).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(billingCommandBackoffMs(30)).toBe(6 * 60 * 60_000);
  });

  it('C1-U-4 confirmation rule: IMMEDIATE needs the provider end; AT_PERIOD_END accepts the schedule or the end', () => {
    expect(subscriptionCancelConfirmed({ mode: 'IMMEDIATE' }, { cancel_at_period_end: true }, false)).toBe(false);
    expect(subscriptionCancelConfirmed({ mode: 'IMMEDIATE' }, { cancel_at_period_end: false }, true)).toBe(true);
    expect(subscriptionCancelConfirmed({ mode: 'AT_PERIOD_END' }, { cancel_at_period_end: true }, false)).toBe(true);
    expect(subscriptionCancelConfirmed({ mode: 'AT_PERIOD_END' }, { cancel_at_period_end: false }, false)).toBe(false);
    expect(subscriptionCancelConfirmed({}, { cancel_at_period_end: true }, true)).toBe(false);
  });
});

describe('CCP-C1 checkout-session envelope', () => {
  it('C1-U-5 a checkout.session.* event carries its session; other events do not; a session object maps to the session state', () => {
    expect(stripeEventCheckoutSessionRef('checkout.session.expired', { id: 'cs_9' })).toBe('cs_9');
    expect(stripeEventCheckoutSessionRef('invoice.paid', { id: 'in_1' })).toBeNull();
    expect(stripeCheckoutSessionState({ id: 'cs_9', status: 'expired', metadata: { tenant_id: 't1', intent_id: 'i1' } })).toEqual({
      provider: 'STRIPE',
      session_ref: 'cs_9',
      status: 'expired',
      tenant_id: 't1',
      intent_id: 'i1',
    });
    expect(stripeCheckoutSessionState({ id: 'cs_8', status: 'open', client_reference_id: 'i2' }).intent_id).toBe('i2');
  });
});

describe('CCP-C1 StripeBillingProvider command port (local stand-in)', () => {
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
        const url = req.url ?? '';
        if (url === '/v1/subscriptions/sub_ok') return res.end(JSON.stringify({ id: 'sub_ok', status: req.method === 'DELETE' ? 'canceled' : 'active' }));
        if (url === '/v1/checkout/sessions/cs_ok/expire') return res.end(JSON.stringify({ id: 'cs_ok', status: 'expired' }));
        if (url === '/v1/checkout/sessions/cs_ok') return res.end(JSON.stringify({ id: 'cs_ok', status: 'open', metadata: { tenant_id: 't1', intent_id: 'i1' } }));
        if (url === '/v1/subscriptions/sub_busy') {
          res.statusCode = 429;
          return res.end(JSON.stringify({ error: { message: 'Too many requests' } }));
        }
        if (url === '/v1/subscriptions/sub_down') {
          res.statusCode = 503;
          return res.end(JSON.stringify({ error: { message: 'Service unavailable' } }));
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: 'No such object' } }));
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

  it('C1-U-6 IMMEDIATE cancel is the provider DELETE; AT_PERIOD_END is an update; both carry the command idempotency key', async () => {
    const p = new StripeBillingProvider();
    await p.cancelSubscription('sub_ok', { at_period_end: false }, 'aramo-ccp-r1-end_self_service');
    await p.cancelSubscription('sub_ok', { at_period_end: true }, 'aramo-ccp-r2-end_self_service');
    const [del, upd] = seen.filter((r) => r.url === '/v1/subscriptions/sub_ok');
    expect(del).toMatchObject({ method: 'DELETE', body: '' });
    expect(del!.headers['idempotency-key']).toBe('aramo-ccp-r1-end_self_service');
    expect(upd!.method).toBe('POST');
    expect(new URLSearchParams(upd!.body).get('cancel_at_period_end')).toBe('true');
    expect(upd!.headers['idempotency-key']).toBe('aramo-ccp-r2-end_self_service');
  });

  it('C1-U-7 expire posts to the session expire path with the key; the session read maps status and metadata', async () => {
    const p = new StripeBillingProvider();
    await p.expireCheckoutSession('cs_ok', 'aramo-ccp-r3-expire_session');
    const req = seen.find((r) => r.url === '/v1/checkout/sessions/cs_ok/expire')!;
    expect(req.method).toBe('POST');
    expect(req.headers['idempotency-key']).toBe('aramo-ccp-r3-expire_session');
    expect(await p.retrieveCheckoutSession('cs_ok')).toEqual({ provider: 'STRIPE', session_ref: 'cs_ok', status: 'open', tenant_id: 't1', intent_id: 'i1' });
  });

  it('C1-U-8 a provider refusal (4xx) is NOT retryable; 429 and 5xx are retryable; a network failure is retryable', async () => {
    const p = new StripeBillingProvider();
    const err = async (f: () => Promise<unknown>) => {
      try {
        await f();
      } catch (e) {
        return e as BillingProviderUnavailableError;
      }
      throw new Error('expected a failure');
    };
    expect((await err(() => p.cancelSubscription('sub_missing', { at_period_end: false }, 'k1'))).retryable).toBe(false);
    expect((await err(() => p.cancelSubscription('sub_busy', { at_period_end: false }, 'k2'))).retryable).toBe(true);
    expect((await err(() => p.cancelSubscription('sub_down', { at_period_end: false }, 'k3'))).retryable).toBe(true);
    process.env['STRIPE_API_BASE'] = 'http://127.0.0.1:1';
    expect((await err(() => p.expireCheckoutSession('cs_ok', 'k4'))).retryable).toBe(true);
    // The pre-C1 constructor default stays retryable (every existing caller unchanged).
    expect(new BillingProviderUnavailableError('x').retryable).toBe(true);
  });

  it('C1-U-9 a verified checkout.session.expired webhook carries checkout_session_ref; other events keep the pre-C1 envelope', () => {
    const p = new StripeBillingProvider();
    const expired = JSON.stringify({ id: 'evt_x', type: 'checkout.session.expired', created: 5, data: { object: { id: 'cs_ok', mode: 'subscription', subscription: null } } });
    expect(p.verifyWebhook(Buffer.from(expired), sign(expired, 1000), 1000)).toEqual({
      id: 'evt_x',
      type: 'checkout.session.expired',
      created: new Date(5000),
      subscription_ref: null,
      checkout_session_ref: 'cs_ok',
    });
    const paid = JSON.stringify({ id: 'evt_y', type: 'invoice.paid', created: 5, data: { object: { subscription: 'sub_1' } } });
    expect(p.verifyWebhook(Buffer.from(paid), sign(paid, 1000), 1000)).toEqual({ id: 'evt_y', type: 'invoice.paid', created: new Date(5000), subscription_ref: 'sub_1' });
  });
});

describe('CCP-C1 module wiring', () => {
  it('C1-U-10 SubscriptionModule binds the command port into the lifecycle (so applied provider states confirm commands), and provides the command service and the inbox', async () => {
    await import('reflect-metadata');
    const { Test } = await import('@nestjs/testing');
    const { SubscriptionModule } = await import('../lib/subscription.module.js');
    const { SubscriptionLifecycleService } = await import('../lib/billing/subscription-lifecycle.service.js');
    const { BillingCommandService } = await import('../lib/billing/billing-command.service.js');
    const { BillingWebhookInboxService } = await import('../lib/billing/billing-webhook-inbox.service.js');
    const { BILLING_PROVIDER_COMMAND_PORT } = await import('../lib/billing/billing-provider.port.js');
    for (const mod of [SubscriptionModule, SubscriptionModule.forRoot()]) {
      const ref = await Test.createTestingModule({ imports: [mod] }).compile();
      const lifecycle = ref.get(SubscriptionLifecycleService) as unknown as { providerCommands?: unknown };
      expect(lifecycle.providerCommands).toBeInstanceOf(StripeBillingProvider);
      expect(ref.get(BILLING_PROVIDER_COMMAND_PORT)).toBeInstanceOf(StripeBillingProvider);
      expect(ref.get(BillingCommandService)).toBeInstanceOf(BillingCommandService);
      expect(ref.get(BillingWebhookInboxService)).toBeInstanceOf(BillingWebhookInboxService);
      await ref.close();
    }
  });
});
