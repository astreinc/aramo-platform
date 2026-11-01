import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentProviderRefusedError, PaymentProviderUnavailableError, PaymentWebhookSignatureError, type PaymentProviderPort } from '@aramo/sign';

import { SignFeatureGate } from '../app/sign-feature.gate.js';
import { SignPaymentsGate, planEntitled, type SignPaymentsPlanSource } from '../app/payments/sign-payments.gate.js';
import { applicationFeeFor, signStripeConnectConfig } from '../app/payments/sign-payments.config.js';
import { StripeConnectPaymentProvider, translateEvent, verifyConnectSignature } from '../app/payments/stripe-connect-payment.provider.js';

// Aramo Sign 1.14 (Feature-Parity directive §1.14; Amendment A1) — payments are built dark:
// sign.payments NOT_AVAILABLE, SIGN_STRIPE_CONNECT_* unset. Unit tests never call Stripe
// (fetch is stubbed).

const ENV_KEYS = ['SIGN_STRIPE_CONNECT_ENABLED', 'SIGN_STRIPE_CONNECT_SECRET_KEY', 'SIGN_STRIPE_CONNECT_WEBHOOK_SECRET', 'SIGN_STRIPE_CONNECT_APPLICATION_FEE_AMOUNT', 'SIGN_STRIPE_CONNECT_API_BASE'];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

function sign(body: string, secret: string, t: number): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

describe('Sign 1.14 — configuration', () => {
  it('is off when nothing is set (the shipped default)', () => {
    const c = signStripeConnectConfig({});
    expect(c.enabled).toBe(false);
    expect(c.secret_key).toBeNull();
    expect(c.application_fee_minor).toBe(0);
    expect(c.api_base).toBe('https://api.stripe.com');
  });
  it('treats a malformed or negative fee as no fee', () => {
    expect(signStripeConnectConfig({ SIGN_STRIPE_CONNECT_APPLICATION_FEE_AMOUNT: '-5' }).application_fee_minor).toBe(0);
    expect(signStripeConnectConfig({ SIGN_STRIPE_CONNECT_APPLICATION_FEE_AMOUNT: '1.5' }).application_fee_minor).toBe(0);
    expect(signStripeConnectConfig({ SIGN_STRIPE_CONNECT_APPLICATION_FEE_AMOUNT: '30' }).application_fee_minor).toBe(30);
  });
  it('caps the fee so the subscriber always receives at least one cent', () => {
    expect(applicationFeeFor(1000, 0)).toBe(0);
    expect(applicationFeeFor(1000, 30)).toBe(30);
    expect(applicationFeeFor(50, 500)).toBe(49);
  });
});

describe('Sign 1.14 — availability gate', () => {
  const provider = (configured: boolean): PaymentProviderPort => ({ configured: () => configured }) as unknown as PaymentProviderPort;
  const plans = (plan_key: string | null): SignPaymentsPlanSource => ({ openPlan: async () => (plan_key === null ? null : { plan_key, features: [] }) });

  it('refuses while sign.payments is NOT_AVAILABLE (the shipped state)', async () => {
    process.env['SIGN_STRIPE_CONNECT_ENABLED'] = '1';
    const gate = new SignPaymentsGate(new SignFeatureGate(), provider(true), plans('aramo-sign-enterprise-v1'));
    expect(await gate.unavailableReason('t1')).toBe('feature_not_available');
    await expect(gate.assertAvailable('t1', 'r1')).rejects.toMatchObject({ code: 'ESIGN_FEATURE_NOT_AVAILABLE' });
  });

  it('then requires configuration, then a Professional or Enterprise plan', async () => {
    const features = { isAvailable: () => true } as unknown as SignFeatureGate;
    expect(await new SignPaymentsGate(features, provider(true), plans('aramo-sign-enterprise-v1')).unavailableReason('t1')).toBe('payments_not_configured');
    process.env['SIGN_STRIPE_CONNECT_ENABLED'] = '1';
    expect(await new SignPaymentsGate(features, provider(false), plans('aramo-sign-enterprise-v1')).unavailableReason('t1')).toBe('payments_not_configured');
    expect(await new SignPaymentsGate(features, provider(true), plans('aramo-sign-standard-business-v1')).unavailableReason('t1')).toBe('plan_not_entitled');
    expect(await new SignPaymentsGate(features, provider(true), plans(null)).unavailableReason('t1')).toBe('plan_not_entitled');
    expect(await new SignPaymentsGate(features, provider(true), plans('aramo-sign-standard-professional-v1')).available('t1')).toBe(true);
  });

  it('accepts a plan whose terms enable sign.payments', () => {
    expect(planEntitled({ plan_key: 'custom', features: [{ feature_key: 'sign.payments', enabled: true }] })).toBe(true);
    expect(planEntitled({ plan_key: 'custom', features: [{ feature_key: 'sign.payments', enabled: false }] })).toBe(false);
  });
});

describe('Sign 1.14 — Connect webhook signature', () => {
  const secret = 'whsec_test';
  const body = '{"id":"evt_1","type":"account.updated"}';
  const now = 1_800_000_000;

  it('accepts a valid signature within tolerance', () => {
    expect(() => verifyConnectSignature(Buffer.from(body), sign(body, secret, now), secret, now + 10)).not.toThrow();
  });
  it.each([
    ['NO_SECRET', () => verifyConnectSignature(Buffer.from(body), sign(body, secret, now), undefined, now)],
    ['MISSING', () => verifyConnectSignature(Buffer.from(body), undefined, secret, now)],
    ['MALFORMED', () => verifyConnectSignature(Buffer.from(body), 'v1=abc', secret, now)],
    ['STALE', () => verifyConnectSignature(Buffer.from(body), sign(body, secret, now), secret, now + 301)],
    ['BAD_SIGNATURE', () => verifyConnectSignature(Buffer.from(`${body} `), sign(body, secret, now), secret, now)],
    ['BAD_SIGNATURE', () => verifyConnectSignature(Buffer.from(body), sign(body, 'whsec_other', now), secret, now)],
  ])('refuses %s', (reason, run) => {
    expect(run).toThrow(PaymentWebhookSignatureError);
    expect(run).toThrow(reason);
  });
});

describe('Sign 1.14 — event translation', () => {
  it('maps checkout completion with the Aramo payment reference', () => {
    const e = translateEvent({
      id: 'evt_1', type: 'checkout.session.completed', account: 'acct_1', livemode: false,
      data: { object: { id: 'cs_1', status: 'complete', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 2500, currency: 'usd', metadata: { aramo_payment_id: 'p1' } } },
    });
    expect(e.kind).toBe('CHECKOUT_COMPLETED');
    if (e.kind !== 'CHECKOUT_COMPLETED') return;
    expect(e.account_ref).toBe('acct_1');
    expect(e.checkout).toMatchObject({ checkout_ref: 'cs_1', paid: true, payment_ref: 'pi_1', amount_minor: 2500, currency: 'USD', payment_id: 'p1' });
  });
  it('maps refunds and charges, and ignores unknown events', () => {
    expect(translateEvent({ id: 'e', type: 'charge.refunded', data: { object: { payment_intent: 'pi_1', amount: 2500, amount_refunded: 500 } } })).toMatchObject({ kind: 'CHARGE_REFUNDED', charge: { payment_ref: 'pi_1', amount_refunded_minor: 500 } });
    expect(translateEvent({ id: 'e', type: 'refund.updated', data: { object: { id: 're_1', status: 'succeeded', amount: 500, payment_intent: 'pi_1', metadata: { aramo_refund_id: 'r1' } } } })).toMatchObject({ kind: 'REFUND_UPDATED', refund: { refund_ref: 're_1', status: 'SUCCEEDED', refund_id: 'r1' } });
    expect(translateEvent({ id: 'e', type: 'invoice.paid', data: { object: {} } }).kind).toBe('OTHER');
  });
});

describe('Sign 1.14 — Stripe Connect adapter (stubbed fetch)', () => {
  function stubFetch(status: number, json: unknown) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(json), { status });
    }));
    return calls;
  }

  it('is unconfigured without keys and refuses to call Stripe', async () => {
    const p = new StripeConnectPaymentProvider();
    expect(p.configured()).toBe(false);
    await expect(p.getAccount('acct_1')).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
  });

  it('creates checkouts as DIRECT charges on the connected account (R-6), no fee by default', async () => {
    process.env['SIGN_STRIPE_CONNECT_SECRET_KEY'] = 'sk_test_x';
    process.env['SIGN_STRIPE_CONNECT_WEBHOOK_SECRET'] = 'whsec_x';
    process.env['SIGN_STRIPE_CONNECT_API_BASE'] = 'https://stripe.test';
    const calls = stubFetch(200, { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1', status: 'open', payment_status: 'unpaid', amount_total: 2500, currency: 'usd' });
    const p = new StripeConnectPaymentProvider();
    expect(p.configured()).toBe(true);
    const s = await p.createCheckout({
      account_ref: 'acct_1', amount_minor: 2500, currency: 'USD', description: 'Lease', application_fee_minor: 0,
      success_url: 'https://s', cancel_url: 'https://c', references: { tenant_id: 't', envelope_id: 'e', payment_id: 'p', field_id: 'f' }, idempotency_key: 'k1',
    });
    expect(s).toMatchObject({ checkout_ref: 'cs_1', status: 'OPEN', paid: false });
    expect(calls[0]?.url).toBe('https://stripe.test/v1/checkout/sessions');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['stripe-account']).toBe('acct_1');
    expect(headers['idempotency-key']).toBe('k1');
    const body = String(calls[0]?.init.body);
    expect(body).toContain('mode=payment');
    expect(body).not.toContain('application_fee_amount');
    expect(body).not.toContain('transfer_data');
  });

  it('creates Standard accounts and separates refusals from outages', async () => {
    process.env['SIGN_STRIPE_CONNECT_SECRET_KEY'] = 'sk_test_x';
    const calls = stubFetch(200, { id: 'acct_1', charges_enabled: false, details_submitted: false, payouts_enabled: false });
    const a = await new StripeConnectPaymentProvider().createAccount({ tenant_id: 't', email: null, idempotency_key: 'k' });
    expect(a).toMatchObject({ account_ref: 'acct_1', charges_enabled: false, live: false });
    expect(String(calls[0]?.init.body)).toContain('type=standard');

    stubFetch(400, { error: { message: 'bad amount' } });
    await expect(new StripeConnectPaymentProvider().getAccount('acct_1')).rejects.toBeInstanceOf(PaymentProviderRefusedError);
    stubFetch(503, {});
    await expect(new StripeConnectPaymentProvider().getAccount('acct_1')).rejects.toBeInstanceOf(PaymentProviderUnavailableError);
  });
});
