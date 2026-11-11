import { generateKeyPairSync } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import type { GooglePlayConfig } from '../lib/billing/store/store-billing.config.js';
import type { BillingSyncTarget } from '../lib/billing/sync/billing-sync.port.js';
import { GooglePlayWriter, mergeRegions, minorToMoney } from '../lib/billing/sync/google-play.writer.js';
import { StripeCatalogWriter, lookupKey } from '../lib/billing/sync/stripe-catalog.writer.js';

// CCP Billing Products Directive v1.0 (LOCKED) §3.2-1 / §3.2-3 — the Stripe catalog writer and the
// Google Play writer against in-memory providers. No network, no credential.

const VERSION = '019a0000-0000-7000-8000-000000000002';
const target = (over: Partial<BillingSyncTarget> = {}): BillingSyncTarget => ({
  provider: 'STRIPE',
  interval: 'MONTH',
  product_id: 'aramo_sign_personal_standard',
  plan_id: '019a0000-0000-7000-8000-000000000001',
  plan_key: 'aramo-sign-standard-personal-v1',
  display_name: 'Standard',
  description: '25 sends a month and 1 GB storage',
  plan_version_id: VERSION,
  version_number: 2,
  prices: [{ country: 'US', currency: 'USD', amount_minor: 1000 }],
  known_external_ref: null,
  review_screenshot: null,
  ...over,
});

describe('Stripe catalog writer (BP-9)', () => {
  let products: Map<string, Record<string, unknown>>;
  let prices: Record<string, unknown>[];
  let calls: { method: string; path: string; idem: string | null; body: URLSearchParams }[];
  const fake = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    const h = new Headers(init?.headers);
    expect(h.get('authorization')).toBe('Bearer sk_test_x');
    const body = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ method, path: u.pathname, idem: h.get('idempotency-key'), body });
    const json = (s: number, v: unknown) => new Response(JSON.stringify(v), { status: s });
    let m: RegExpExecArray | null;
    if ((m = /^\/v1\/products\/(.+)$/.exec(u.pathname))) {
      const p = products.get(decodeURIComponent(m[1]!));
      if (method === 'GET') return p ? json(200, p) : json(404, { error: { type: 'invalid_request_error' } });
      Object.assign(p!, Object.fromEntries(body));
      return json(200, p);
    }
    if (u.pathname === '/v1/products') {
      const p = { id: body.get('id'), name: body.get('name'), description: body.get('description'), active: true };
      products.set(String(p.id), p);
      return json(200, p);
    }
    if (u.pathname === '/v1/prices' && method === 'GET') {
      const lk = u.searchParams.get('lookup_keys[]');
      return json(200, { data: prices.filter((p) => p['lookup_key'] === lk) });
    }
    if (u.pathname === '/v1/prices') {
      const p = { id: `price_${prices.length + 1}`, product: body.get('product'), currency: body.get('currency'), unit_amount: Number(body.get('unit_amount')), recurring: { interval: body.get('recurring[interval]') }, lookup_key: body.get('lookup_key') };
      prices.push(p);
      return json(200, p);
    }
    return json(500, {});
  };
  let w: StripeCatalogWriter;
  beforeEach(() => {
    products = new Map();
    prices = [];
    calls = [];
    w = new StripeCatalogWriter(fake, { key: () => 'sk_test_x', base: () => 'https://stripe.test' });
  });

  it('creates the product (Aramo id) and one price for the version, idempotently', async () => {
    const a = await w.sync(target());
    expect(a).toMatchObject({ status: 'SYNCED', origin: 'CREATED', external_price_ref: 'price_1' });
    expect(products.get('aramo_sign_personal_standard')).toMatchObject({ name: 'Standard' });
    expect(prices[0]).toMatchObject({ unit_amount: 1000, currency: 'usd', recurring: { interval: 'month' }, lookup_key: lookupKey(VERSION, 'MONTH') });
    expect(calls.find((c) => c.path === '/v1/prices' && c.method === 'POST')?.idem).toBe(`ccp-price-${lookupKey(VERSION, 'MONTH')}`);
    const b = await w.sync(target({ known_external_ref: null }));
    expect(b.external_price_ref).toBe('price_1');
    expect(prices).toHaveLength(1);
  });
  it('adopts an existing product and updates its name', async () => {
    products.set('aramo_sign_personal_standard', { id: 'aramo_sign_personal_standard', name: 'Old', description: '', active: true });
    const a = await w.sync(target());
    expect(a.origin).toBe('ADOPTED');
    expect(products.get('aramo_sign_personal_standard')).toMatchObject({ name: 'Standard' });
  });
  it('refuses a version price that already exists with other terms', async () => {
    prices.push({ id: 'price_x', product: 'aramo_sign_personal_standard', currency: 'usd', unit_amount: 999, recurring: { interval: 'month' }, lookup_key: lookupKey(VERSION, 'MONTH') });
    await expect(w.sync(target())).rejects.toMatchObject({ code: 'PROVIDER_REJECTED' });
  });
  it('is dark without a key and reports the live price', async () => {
    const dark = new StripeCatalogWriter(fake, { key: () => undefined, base: () => 'https://stripe.test' });
    expect(dark.configured()).toBe(false);
    await expect(dark.sync(target())).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await w.sync(target());
    expect(await w.livePrices(target())).toEqual([{ country: 'US', currency: 'USD', amount_minor: 1000 }]);
  });
});

describe('Google Play writer (BP-8)', () => {
  const sa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cfg: GooglePlayConfig = {
    package_name: 'ai.aramo.sign',
    credentials: { client_email: 'ccp@aramo-sign.iam.gserviceaccount.com', private_key: sa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    rtdn_audience: null,
    rtdn_service_account: null,
  };
  let subs: Map<string, Record<string, any>>;
  let writes: string[];
  const fake = async (url: string, init?: RequestInit): Promise<Response> => {
    const json = (s: number, v: unknown) => new Response(JSON.stringify(v), { status: s });
    if (url === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'tok', expires_in: 3600 });
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') writes.push(`${method} ${u.pathname}`);
    let m: RegExpExecArray | null;
    if ((m = /\/subscriptions\/([^/]+)\/basePlans\/(\w+):activate$/.exec(u.pathname))) {
      const s = subs.get(decodeURIComponent(m[1]!))!;
      for (const b of s['basePlans']) if (b.basePlanId === m[2]) b.state = 'ACTIVE';
      return json(200, s);
    }
    if ((m = /\/subscriptions\/([^/]+)$/.exec(u.pathname))) {
      const id = decodeURIComponent(m[1]!);
      if (method === 'GET') return subs.has(id) ? json(200, subs.get(id)) : json(404, {});
      const body = JSON.parse(String(init?.body));
      subs.set(id, { ...body, basePlans: body.basePlans.map((b: Record<string, unknown>) => ({ state: 'DRAFT', ...b })) });
      return json(200, subs.get(id));
    }
    if (/\/subscriptions$/.test(u.pathname) && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      expect(u.searchParams.get('regionsVersion.version')).toBe('2022/02');
      subs.set(u.searchParams.get('productId')!, { ...body, basePlans: body.basePlans.map((b: Record<string, unknown>) => ({ ...b, state: 'DRAFT' })) });
      return json(200, subs.get(u.searchParams.get('productId')!));
    }
    return json(500, {});
  };
  let w: GooglePlayWriter;
  const play = (over: Partial<BillingSyncTarget> = {}) => target({ provider: 'GOOGLE_PLAY', product_id: 'ai.aramo.sign.personal_standard.monthly', ...over });
  beforeEach(() => {
    subs = new Map();
    writes = [];
    w = new GooglePlayWriter(cfg, fake, () => Date.parse('2026-11-11T12:00:00Z'));
  });

  it('creates the first Play product from the console (never by hand), exact price, and activates it', async () => {
    const out = await w.sync(play());
    expect(out).toMatchObject({ status: 'SYNCED', origin: 'CREATED', store_state: 'ACTIVE' });
    const s = subs.get('ai.aramo.sign.personal_standard.monthly')!;
    expect(s['listings']).toEqual([{ languageCode: 'en-US', title: 'Standard', description: '25 sends a month and 1 GB storage' }]);
    expect(s['basePlans'][0]).toMatchObject({ basePlanId: 'monthly', autoRenewingBasePlanType: { billingPeriodDuration: 'P1M' }, regionalConfigs: [{ regionCode: 'US', newSubscriberAvailability: true, price: { currencyCode: 'USD', units: '10', nanos: 0 } }] });
  });
  it('is idempotent and closes regions the catalog no longer sells in (never removes them)', async () => {
    await w.sync(play({ prices: [{ country: 'US', currency: 'USD', amount_minor: 1000 }, { country: 'IN', currency: 'INR', amount_minor: 99900 }] }));
    writes = [];
    await w.sync(play({ known_external_ref: null, prices: [{ country: 'US', currency: 'USD', amount_minor: 1000 }, { country: 'IN', currency: 'INR', amount_minor: 99900 }] }));
    expect(writes).toEqual([]);
    await w.sync(play());
    const rc = subs.get('ai.aramo.sign.personal_standard.monthly')!['basePlans'][0].regionalConfigs;
    expect(rc).toEqual([
      { regionCode: 'IN', newSubscriberAvailability: false, price: { currencyCode: 'INR', units: '999', nanos: 0 } },
      { regionCode: 'US', newSubscriberAvailability: true, price: { currencyCode: 'USD', units: '10', nanos: 0 } },
    ]);
    expect(await w.livePrices(play())).toEqual([{ country: 'US', currency: 'USD', amount_minor: 1000 }]);
  });
  it('converts minor units to Google Money exactly, and merges regions', () => {
    expect(minorToMoney(999, 'USD')).toEqual({ currencyCode: 'USD', units: '9', nanos: 990000000 });
    expect(minorToMoney(1500, 'JPY')).toEqual({ currencyCode: 'JPY', units: '1500', nanos: 0 });
    expect(mergeRegions([{ regionCode: 'GB', newSubscriberAvailability: true }], [{ regionCode: 'US', newSubscriberAvailability: true }]).map((r) => [r.regionCode, r.newSubscriberAvailability])).toEqual([['GB', false], ['US', true]]);
  });
  it('is dark without configuration', async () => {
    await expect(new GooglePlayWriter(null, fake).sync(play())).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });
});
