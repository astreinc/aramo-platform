import { afterEach, describe, expect, it, vi } from 'vitest';

import { BillingProviderUnavailableError } from '../lib/billing/billing-provider.port.js';
import { StripeBillingProvider } from '../lib/billing/stripe-billing.provider.js';
import { WIRE_METER_EVENTS_PATH, wireMeterEventParams, wireMeterEventRef } from '../lib/billing/stripe-wire.js';
import { ProductContextError } from '../lib/product-registry.js';
import { METERED_UNIT_KEYS, isMeteredUnitKey, productOfMeteredUnit, usageBillingEnabled } from '../lib/usage/metered-units.js';
import { USAGE_MAX_AGE_MS, USAGE_MAX_FUTURE_MS, validateRecordInput, validateUsageInput } from '../lib/usage/metered-usage.service.js';
import { usageReportBackoffMs } from '../lib/usage/usage-provider-report.service.js';

// Sign usage / metered billing (Feature Parity D-2, A1) — the pure parts: the unit registry mirror,
// the flag, input validation, the Stripe meter-event wire translation and the adapter request (a
// stubbed fetch; no network), and the report backoff.

const T = '0190dddd-0000-7000-8000-0000000000a1';
const NOW = new Date('2026-11-10T12:00:00.000Z');
const base = { tenant_id: T, unit: 'sign.sms_message', quantity: 1, idempotency_key: 'k', source_ref: 'sign:envelope:x' };

describe('metered unit registry and flag', () => {
  it('lists the seven Sign units, each mapping to the sign product', () => {
    expect(METERED_UNIT_KEYS).toEqual(['sign.sms_message', 'sign.whatsapp_message', 'sign.sms_otp', 'sign.id_verification', 'sign.kba', 'sign.qes_signature', 'sign.india_estamp']);
    for (const k of METERED_UNIT_KEYS) expect(productOfMeteredUnit(k)).toBe('sign');
    expect(isMeteredUnitKey('sign.envelopes')).toBe(false);
    expect(isMeteredUnitKey(42)).toBe(false);
    expect(() => productOfMeteredUnit('ats.sms' as never)).toThrow(ProductContextError);
  });

  it('is on only with SIGN_USAGE_BILLING_ENABLED=1', () => {
    expect(usageBillingEnabled({})).toBe(false);
    expect(usageBillingEnabled({ SIGN_USAGE_BILLING_ENABLED: '0' })).toBe(false);
    expect(usageBillingEnabled({ SIGN_USAGE_BILLING_ENABLED: 'true' })).toBe(false);
    expect(usageBillingEnabled({ SIGN_USAGE_BILLING_ENABLED: '1' })).toBe(true);
  });
});

describe('UsageRecorder input validation', () => {
  it('accepts a well-formed record', () => {
    expect(validateRecordInput(base, NOW)).toBeNull();
    expect(validateRecordInput({ ...base, occurred_at: new Date(NOW.getTime() - USAGE_MAX_AGE_MS + 1) }, NOW)).toBeNull();
    expect(validateRecordInput({ ...base, occurred_at: new Date(NOW.getTime() + USAGE_MAX_FUTURE_MS) }, NOW)).toBeNull();
  });

  it('refuses an unknown unit and a malformed tenant', () => {
    expect(validateUsageInput({ tenant_id: T, unit: 'sign.envelopes' })).toMatchObject({ reason: 'UNKNOWN_UNIT' });
    expect(validateUsageInput({ tenant_id: 'x', unit: 'sign.kba' })).toMatchObject({ reason: 'INVALID_INPUT' });
  });

  it.each([
    ['quantity 0', { quantity: 0 }],
    ['fractional quantity', { quantity: 0.5 }],
    ['quantity above the cap', { quantity: 100_001 }],
    ['empty key', { idempotency_key: '' }],
    ['long key', { idempotency_key: 'k'.repeat(201) }],
    ['empty source_ref', { source_ref: '' }],
    ['long source_ref', { source_ref: 's'.repeat(301) }],
    ['invalid date', { occurred_at: new Date('nope') }],
    ['future occurred_at', { occurred_at: new Date(NOW.getTime() + USAGE_MAX_FUTURE_MS + 1) }],
    ['stale occurred_at', { occurred_at: new Date(NOW.getTime() - USAGE_MAX_AGE_MS - 1) }],
  ])('refuses %s as INVALID_INPUT', (_n, over) => {
    expect(validateRecordInput({ ...base, ...over }, NOW)).toMatchObject({ ok: false, reason: 'INVALID_INPUT' });
  });
});

describe('Stripe meter events (wire + adapter)', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });
  const event = { event_name: 'aramo_sign_sms', account_ref: 'acct_1', value: 3, identifier: '019a-entry', occurred_at: NOW };

  it('translates a report to the meter-event params (seconds timestamp, string value)', () => {
    expect(WIRE_METER_EVENTS_PATH).toBe('/v1/billing/meter_events');
    const params = wireMeterEventParams(event);
    expect(params).toMatchObject({ event_name: 'aramo_sign_sms', identifier: '019a-entry', timestamp: String(NOW.getTime() / 1000), 'payload[value]': '3' });
    // The billing-account payload key is the provider's own field name (named only in stripe-wire.ts).
    const accountKeys = Object.keys(params).filter((k) => k.startsWith('payload[') && k !== 'payload[value]');
    expect(accountKeys).toHaveLength(1);
    expect(params[accountKeys[0] as string]).toBe('acct_1');
    expect(Object.keys(params)).toHaveLength(5);
    expect(wireMeterEventRef({ identifier: 'abc' })).toBe('abc');
    expect(wireMeterEventRef({})).toBeNull();
  });

  it('posts one form-encoded meter event with the pinned API version and an idempotency key', async () => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_x';
    process.env['STRIPE_API_BASE'] = 'https://stripe.test';
    const fetch = vi.fn(async () => new Response(JSON.stringify({ object: 'billing.meter_event', identifier: '019a-entry' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const p = new StripeBillingProvider();
    expect(p.meterReportingConfigured()).toBe(true);
    expect(await p.reportMeterEvent(event)).toEqual({ provider_event_ref: '019a-entry' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://stripe.test/v1/billing/meter_events');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['stripe-version']).toBe('2024-06-20');
    expect(headers['idempotency-key']).toBe('aramo-usage-019a-entry');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('event_name')).toBe('aramo_sign_sms');
    expect(body.get('payload[value]')).toBe('3');
  });

  it('a 4xx is a non-retryable refusal, a 5xx is retryable, and no key means not configured', async () => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_x';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'no such meter' } }), { status: 400 })));
    const p = new StripeBillingProvider();
    await expect(p.reportMeterEvent(event)).rejects.toMatchObject({ retryable: false });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 502 })));
    await expect(p.reportMeterEvent(event)).rejects.toBeInstanceOf(BillingProviderUnavailableError);
    await expect(p.reportMeterEvent(event)).rejects.toMatchObject({ retryable: true });
    delete process.env['STRIPE_SECRET_KEY'];
    expect(p.meterReportingConfigured()).toBe(false);
  });
});

describe('usage report backoff', () => {
  it('doubles from one minute and caps at six hours', () => {
    expect(usageReportBackoffMs(1)).toBe(60_000);
    expect(usageReportBackoffMs(2)).toBe(120_000);
    expect(usageReportBackoffMs(5)).toBe(16 * 60_000);
    expect(usageReportBackoffMs(20)).toBe(6 * 3_600_000);
  });
});
