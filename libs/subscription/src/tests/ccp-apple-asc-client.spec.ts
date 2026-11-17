import { createHash, generateKeyPairSync } from 'node:crypto';

import { decodeProtectedHeader, importSPKI, jwtVerify } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';

import { AppleAscClient, appleAscConfig, type AppleAscConfig } from '../lib/billing/sync/apple-asc.client.js';
import { wirePricePointAttributes } from '../lib/billing/sync/apple-asc-wire.js';
import { BillingSyncError, type BillingSyncTarget } from '../lib/billing/sync/billing-sync.port.js';

// CCP Billing Products Directive v1.0 (LOCKED) §3.2-2 — the App Store Connect client against an
// in-memory App Store Connect whose resource shapes are copied from live read-only responses
// (2026-11-11: group 22560615, subscription 6832501043, its price points, prices, localizations, plan
// availability and review screenshot). Keys are generated per run; no network.

const GROUP = '22560615';
const SUB = '6832501043';
const PRODUCT = 'ai.aramo.sign.personal_standard.monthly';
const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const config: AppleAscConfig = {
  issuer_id: '1e547d56-97c6-4357-aca8-7a0698fdc83e',
  key_id: 'TESTKEY123',
  private_key_pem: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  app_id: '6832497286',
  subscription_group_id: GROUP,
};

const point = (sub: string, terr: string, p: string) => Buffer.from(JSON.stringify({ s: sub, t: terr, p })).toString('base64url');

interface FakeSub {
  id: string;
  productId: string;
  period: string;
  state: string;
  loc: { id: string; name: string; description: string; state?: string } | null;
  prices: Record<string, string>; // territory → point id
  scheduled?: Record<string, { pid: string; startDate: string }[]>; // territory → changes after today
  availability: { id: string; territories: string[]; newTerritories: boolean } | null;
  shot: { id: string; md5: string | null } | null;
}

// The live answer to a PATCH of an approved localization (prod, 2026-11-17; the id is illustrative).
const UNMODIFIABLE_409 = {
  errors: [
    {
      id: '8fa66072-0000-4000-8000-000000000000',
      status: '409',
      code: 'ENTITY_ERROR.ATTRIBUTE.INVALID.UNMODIFIABLE',
      title: 'The provided entity contains a field that can not be modified in the current state',
      detail: 'Cannot edit SubscriptionLocalization when it is in ACTIVE state',
      source: { pointer: '/data/attributes/state' },
    },
  ],
};

/** An in-memory App Store Connect. `writes` records every non-GET call. */
class FakeAsc {
  subs = new Map<string, FakeSub>();
  points: Record<string, { p: string; amount: string }[]> = {
    USA: [
      { p: '10127', amount: '9.99' },
      { p: '10128', amount: '10.0' },
      { p: '10132', amount: '10.99' },
    ],
    IND: [
      { p: '20001', amount: '499.0' },
      { p: '20002', amount: '999.0' },
    ],
  };
  writes: string[] = [];
  uploads: { url: string; bytes: number }[] = [];
  failNext: { status: number; body: string } | null = null;
  priceBodies: { territory: string; startDate: string | null; preserveCurrentPrice: boolean }[] = [];
  tokens: string[] = [];
  private seq = 1;

  seedExisting(): void {
    this.subs.set(SUB, {
      id: SUB,
      productId: PRODUCT,
      period: 'ONE_MONTH',
      state: 'READY_TO_SUBMIT',
      loc: { id: 'f909786b-loc', name: 'Standard', description: '25 sends a month & 1GB storage. Signing is always free' },
      prices: { USA: point(SUB, 'USA', '10127'), IND: point(SUB, 'IND', '20002') },
      availability: { id: 'eyJhIjoiNjgzMjUwMTA0MyIsInAiOiIwIn0', territories: ['IND', 'USA'], newTerritories: false },
      shot: { id: 'shot-1', md5: 'old-md5' },
    });
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.startsWith('https://upload.example/')) {
      this.uploads.push({ url, bytes: (init?.body as Buffer).byteLength });
      return new Response('', { status: 200 });
    }
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    this.tokens.push(auth.replace(/^Bearer /, ''));
    if (this.failNext !== null) {
      const f = this.failNext;
      this.failNext = null;
      return new Response(f.body, { status: f.status });
    }
    const u = new URL(url);
    const path = u.pathname;
    const q = u.searchParams;
    const body = init?.body ? (JSON.parse(String(init.body)) as { data: Record<string, any> }) : null;
    if (method !== 'GET') this.writes.push(`${method} ${path}`);
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status });
    let m: RegExpExecArray | null;

    if (method === 'GET' && (m = /^\/v1\/subscriptionGroups\/(\d+)\/subscriptions$/.exec(path))) {
      const pid = q.get('filter[productId]');
      const list = [...this.subs.values()].filter((s) => pid === null || s.productId === pid).slice(0, Number(q.get('limit') ?? 50));
      return json(200, { data: list.map((s) => this.subRes(s)) });
    }
    if ((m = /^\/v1\/subscriptions\/(\w+)$/.exec(path)) && method === 'GET') {
      const s = this.subs.get(m[1]!);
      return s ? json(200, { data: this.subRes(s) }) : json(404, { errors: [{ status: '404', code: 'NOT_FOUND', title: 'not found', detail: 'x' }] });
    }
    if (path === '/v1/subscriptions' && method === 'POST') {
      const a = body!.data['attributes'];
      const id = `68325${String(this.seq++).padStart(5, '0')}`;
      const s: FakeSub = { id, productId: a.productId, period: a.subscriptionPeriod, state: 'MISSING_METADATA', loc: null, prices: {}, availability: null, shot: null };
      this.subs.set(id, s);
      return json(201, { data: this.subRes(s) });
    }
    if ((m = /^\/v1\/subscriptions\/(\w+)\/subscriptionLocalizations$/.exec(path))) {
      const s = this.subs.get(m[1]!)!;
      return json(200, {
        data: s.loc ? [{ type: 'subscriptionLocalizations', id: s.loc.id, attributes: { locale: 'en-US', name: s.loc.name, description: s.loc.description, ...(s.loc.state !== undefined ? { state: s.loc.state } : {}) } }] : [],
      });
    }
    if (path === '/v1/subscriptionLocalizations' && method === 'POST') {
      const s = this.subs.get(body!.data['relationships'].subscription.data.id)!;
      s.loc = { id: `loc-${this.seq++}`, name: body!.data['attributes'].name, description: body!.data['attributes'].description };
      return json(201, { data: { type: 'subscriptionLocalizations', id: s.loc.id } });
    }
    if ((m = /^\/v1\/subscriptionLocalizations\/(.+)$/.exec(path)) && method === 'PATCH') {
      const s = [...this.subs.values()].find((x) => x.loc?.id === decodeURIComponent(m![1]!))!;
      if (s.loc!.state === 'APPROVED' || s.loc!.state === 'WAITING_FOR_REVIEW') return json(409, UNMODIFIABLE_409);
      s.loc = { ...s.loc!, ...body!.data['attributes'] };
      return json(200, { data: { type: 'subscriptionLocalizations', id: s.loc!.id } });
    }
    if ((m = /^\/v1\/subscriptions\/(\w+)\/pricePoints$/.exec(path))) {
      const terr = q.get('filter[territory]')!;
      const cursor = Number(q.get('cursor') ?? 0);
      const all = (this.points[terr] ?? []).map((x) => ({ type: 'subscriptionPricePoints', id: point(m![1]!, terr, x.p), attributes: { ...wirePricePointAttributes(x.amount), proceeds: '1', proceedsYear2: '1' } }));
      // Two pages, like the live API (links.next with a cursor).
      const page = all.slice(cursor, cursor + 2);
      const next = cursor + 2 < all.length ? `https://api.appstoreconnect.apple.com${path}?filter%5Bterritory%5D=${terr}&cursor=${cursor + 2}&limit=200` : undefined;
      return json(200, { data: page, links: { self: url, ...(next ? { next } : {}) } });
    }
    if ((m = /^\/v1\/subscriptions\/(\w+)\/prices$/.exec(path))) {
      const s = this.subs.get(m[1]!)!;
      const terr = q.get('filter[territory]')!;
      const pid = s.prices[terr];
      if (pid === undefined) return json(200, { data: [], included: [] });
      const amountOf = (id: string) => (this.points[terr] ?? []).find((x) => point(s.id, terr, x.p) === id)!.amount;
      const rows = [{ pid, startDate: null as string | null }, ...(s.scheduled?.[terr] ?? [])];
      return json(200, {
        data: rows.map((r, i) => ({ type: 'subscriptionPrices', id: `price-${terr}-${i}`, attributes: { startDate: r.startDate, preserved: false, planType: 'UPFRONT' }, relationships: { subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: r.pid } } } })),
        included: [...new Set(rows.map((r) => r.pid))].map((id) => ({ type: 'subscriptionPricePoints', id, attributes: wirePricePointAttributes(amountOf(id)) })),
      });
    }
    if (path === '/v1/subscriptionPrices' && method === 'POST') {
      const r = body!.data['relationships'];
      const a = body!.data['attributes'];
      const s = this.subs.get(r.subscription.data.id)!;
      const terr = r.territory.data.id as string;
      this.priceBodies.push({ territory: terr, startDate: a.startDate, preserveCurrentPrice: a.preserveCurrentPrice });
      if (a.startDate !== null) {
        s.scheduled = { ...(s.scheduled ?? {}), [terr]: [...(s.scheduled?.[terr] ?? []), { pid: r.subscriptionPricePoint.data.id, startDate: a.startDate }] };
        return json(201, { data: { type: 'subscriptionPrices', id: 'p' } });
      }
      // The live answer for an approved product that already has a price (prod, 2026-11-17).
      if (s.state === 'APPROVED' && s.prices[terr] !== undefined) {
        return json(409, { errors: [{ status: '409', code: 'STATE_ERROR', title: 'The request cannot be fulfilled because of the state of another resource.', detail: 'Initial price cannot be created again after subscription is approved.' }] });
      }
      s.prices[terr] = r.subscriptionPricePoint.data.id;
      return json(201, { data: { type: 'subscriptionPrices', id: 'p' } });
    }
    if ((m = /^\/v1\/subscriptions\/(\w+)\/planAvailabilities$/.exec(path))) {
      // Apple (live, 2026-11-11): an included relationship is capped at 50 — limit[availableTerritories]=200 is a 400.
      const lim = q.get('limit[availableTerritories]');
      if (lim !== null && Number(lim) > 50) return json(400, { errors: [{ status: '400', code: 'PARAMETER_ERROR.INVALID', detail: "The maximum allowable limit is '50'" }] });
      const a = this.subs.get(m[1]!)!.availability;
      return json(200, { data: a ? [{ type: 'subscriptionPlanAvailabilities', id: a.id, attributes: { availableInNewTerritories: a.newTerritories, planType: 'UPFRONT' }, relationships: { availableTerritories: { links: { related: `https://api.appstoreconnect.apple.com/v1/subscriptionPlanAvailabilities/${a.id}/availableTerritories` } } } }] : [] });
    }
    if ((m = /^\/v1\/subscriptionPlanAvailabilities\/([^/]+)\/relationships\/availableTerritories$/.exec(path)) && method === 'GET') {
      const s = [...this.subs.values()].find((x) => x.availability?.id === decodeURIComponent(m![1]!))!;
      const all = s.availability!.territories;
      const cursor = Number(q.get('cursor') ?? '0');
      const next = cursor + 2 < all.length ? `https://api.appstoreconnect.apple.com${path}?cursor=${cursor + 2}&limit=200` : undefined;
      return json(200, { data: all.slice(cursor, cursor + 2).map((id) => ({ type: 'territories', id })), links: { self: url, ...(next ? { next } : {}) } });
    }
    if (path === '/v1/subscriptionPlanAvailabilities' && method === 'POST') {
      const r = body!.data['relationships'];
      this.subs.get(r.subscription.data.id)!.availability = { id: `av-${this.seq++}`, territories: r.availableTerritories.data.map((x: { id: string }) => x.id), newTerritories: body!.data['attributes'].availableInNewTerritories };
      return json(201, { data: { type: 'subscriptionPlanAvailabilities', id: 'av' } });
    }
    if ((m = /^\/v1\/subscriptionPlanAvailabilities\/(.+)$/.exec(path)) && method === 'PATCH') {
      const s = [...this.subs.values()].find((x) => x.availability?.id === decodeURIComponent(m![1]!))!;
      s.availability = { ...s.availability!, territories: body!.data['relationships'].availableTerritories.data.map((x: { id: string }) => x.id), newTerritories: body!.data['attributes'].availableInNewTerritories };
      return json(200, { data: { type: 'subscriptionPlanAvailabilities', id: s.availability.id } });
    }
    if ((m = /^\/v1\/subscriptions\/(\w+)\/appStoreReviewScreenshot$/.exec(path))) {
      const sh = this.subs.get(m[1]!)!.shot;
      return json(200, { data: sh ? { type: 'subscriptionAppStoreReviewScreenshots', id: sh.id, attributes: { fileName: 'SOURCE', sourceFileChecksum: sh.md5 } } : null });
    }
    if ((m = /^\/v1\/subscriptionAppStoreReviewScreenshots\/(.+)$/.exec(path))) {
      const s = [...this.subs.values()].find((x) => x.shot?.id === decodeURIComponent(m![1]!))!;
      if (method === 'DELETE') {
        s.shot = null;
        return new Response(null, { status: 204 });
      }
      s.shot = { ...s.shot!, md5: body!.data['attributes'].sourceFileChecksum };
      if (s.state === 'MISSING_METADATA') s.state = 'READY_TO_SUBMIT';
      return json(200, { data: { type: 'subscriptionAppStoreReviewScreenshots', id: s.shot.id } });
    }
    if (path === '/v1/subscriptionAppStoreReviewScreenshots' && method === 'POST') {
      const s = this.subs.get(body!.data['relationships'].subscription.data.id)!;
      s.shot = { id: `shot-${this.seq++}`, md5: null };
      const size = body!.data['attributes'].fileSize as number;
      return json(201, {
        data: {
          type: 'subscriptionAppStoreReviewScreenshots',
          id: s.shot.id,
          attributes: { uploadOperations: [{ method: 'PUT', url: 'https://upload.example/part1', offset: 0, length: size, requestHeaders: [{ name: 'Content-Type', value: 'image/png' }] }] },
        },
      });
    }
    return json(500, { errors: [{ status: '500', code: 'UNHANDLED', title: 'fake', detail: `${method} ${path}` }] });
  };

  private subRes(s: FakeSub) {
    return { type: 'subscriptions', id: s.id, attributes: { name: 'Personal Standard Monthly', productId: s.productId, familySharable: false, state: s.state, subscriptionPeriod: s.period, groupLevel: 1 } };
  }
}

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
const target = (over: Partial<BillingSyncTarget> = {}): BillingSyncTarget => ({
  provider: 'APP_STORE',
  interval: 'MONTH',
  product_id: PRODUCT,
  plan_id: '019a0000-0000-7000-8000-000000000001',
  plan_key: 'aramo-sign-standard-personal-v1',
  display_name: 'Standard',
  description: '25 sends a month and 1 GB storage',
  plan_version_id: '019a0000-0000-7000-8000-000000000002',
  version_number: 2,
  prices: [{ country: 'US', currency: 'USD', amount_minor: 1000 }],
  known_external_ref: null,
  // The seeded product sells in US + IN; these fixtures confirm the IN stop unless a test says otherwise (A1-2).
  stop_countries: ['IN'],
  review_screenshot: { file_name: 'plans.png', content_type: 'image/png', bytes: PNG, sha256: createHash('sha256').update(PNG).digest('hex') },
  ...over,
});

let asc: FakeAsc;
let client: AppleAscClient;
beforeEach(() => {
  asc = new FakeAsc();
  client = new AppleAscClient(config, asc.fetch, () => NOW);
});

describe('adopt the existing product (BP-4) and set the exact catalog price (BP-5)', () => {
  it('moves $9.99 → $10.00, updates the text, narrows the countries to the catalog, replaces the screenshot', async () => {
    asc.seedExisting();
    const out = await client.sync(target());
    expect(out).toMatchObject({ status: 'SYNCED', origin: 'ADOPTED', external_ref: SUB, store_state: 'READY_TO_SUBMIT' });
    expect(out.detail).toMatch(/manual step/);
    const s = asc.subs.get(SUB)!;
    expect(s.prices['USA']).toBe(point(SUB, 'USA', '10128'));
    expect(s.loc).toMatchObject({ name: 'Standard', description: '25 sends a month and 1 GB storage' });
    expect(s.availability).toMatchObject({ territories: ['USA'], newTerritories: false });
    expect(s.shot?.md5).toBe(createHash('md5').update(PNG).digest('hex'));
    expect(asc.uploads).toEqual([{ url: 'https://upload.example/part1', bytes: PNG.byteLength }]);
    expect(asc.writes).not.toContain('POST /v1/subscriptions');
  });

  it('is idempotent: a second run writes nothing', async () => {
    asc.seedExisting();
    await client.sync(target());
    asc.writes = [];
    const again = await client.sync(target({ known_external_ref: SUB }));
    expect(again.origin).toBe('EXISTING');
    expect(asc.writes).toEqual([]);
  });

  it('keeps a regional price exactly (India ₹999 stays)', async () => {
    asc.seedExisting();
    await client.sync(target({ prices: [{ country: 'US', currency: 'USD', amount_minor: 1000 }, { country: 'IN', currency: 'INR', amount_minor: 99900 }] }));
    const s = asc.subs.get(SUB)!;
    expect(s.prices['IND']).toBe(point(SUB, 'IND', '20002'));
    expect(s.availability?.territories).toEqual(['IND', 'USA']);
  });
});

describe('never narrows the countries silently (A1-2)', () => {
  it('refuses, before any write, a version without an IN price that does not confirm the IN stop', async () => {
    asc.seedExisting();
    const e = await client.sync(target({ stop_countries: [] })).catch((x: unknown) => x);
    expect((e as BillingSyncError).code).toBe('PROVIDER_REJECTED');
    expect((e as BillingSyncError).message).toMatch(/sells this plan in IN today/);
    expect(asc.writes).toEqual([]);
  });
  it('reports the live countries (ISO alpha-2), or null for a product that does not exist yet', async () => {
    expect(await client.liveCountries(target())).toBeNull();
    asc.seedExisting();
    expect(await client.liveCountries(target())).toEqual(['IN', 'US']);
  });
  it('reads every territory across pages and never asks Apple for more than 50 included (prod 400, 2026-11-11)', async () => {
    asc.seedExisting();
    asc.subs.get(SUB)!.availability!.territories = ['CAN', 'DEU', 'GBR', 'IND', 'USA'];
    expect(await client.liveCountries(target())).toEqual(['CA', 'DE', 'GB', 'IN', 'US']);
    const e = await client.sync(target({ stop_countries: ['IN'] })).catch((x: unknown) => x);
    expect((e as BillingSyncError).message).toMatch(/sells this plan in CA, DE, GB today/);
    expect(asc.writes).toEqual([]);
  });
});

describe('never rounds (BP-5)', () => {
  it('refuses an amount with no exact App Store price point, naming the nearest', async () => {
    asc.seedExisting();
    const e = await client.sync(target({ prices: [{ country: 'US', currency: 'USD', amount_minor: 1050 }] })).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BillingSyncError);
    expect((e as BillingSyncError).code).toBe('PRICE_POINT_UNAVAILABLE');
    expect((e as BillingSyncError).message).toMatch(/nearest: 1000, 1099/);
    expect(asc.subs.get(SUB)!.prices['USA']).toBe(point(SUB, 'USA', '10127'));
  });
  it('previews exact availability and alternatives', async () => {
    asc.seedExisting();
    const pv = await client.preview(target({ prices: [{ country: 'US', currency: 'USD', amount_minor: 1000 }, { country: 'IN', currency: 'INR', amount_minor: 80000 }] }));
    expect(pv).toEqual([
      { country: 'US', currency: 'USD', amount_minor: 1000, available: true, nearest: [] },
      { country: 'IN', currency: 'INR', amount_minor: 80000, available: false, nearest: [49900, 99900] },
    ]);
  });
});

describe('create a new product', () => {
  it('creates the subscription with family sharing off, then text, price, countries and screenshot', async () => {
    asc.seedExisting();
    const out = await client.sync(target({ product_id: 'ai.aramo.sign.personal_plus.monthly', display_name: 'Plus' }));
    expect(out.origin).toBe('CREATED');
    expect(asc.writes.slice(0, 2)).toEqual(['POST /v1/subscriptions', 'POST /v1/subscriptionLocalizations']);
    expect(asc.writes).toContain('POST /v1/subscriptionPlanAvailabilities');
    expect(asc.writes).toContain('POST /v1/subscriptionAppStoreReviewScreenshots');
    expect(out.store_state).toBe('READY_TO_SUBMIT');
  });
  it('refuses to create one without the review screenshot (BP-7)', async () => {
    const e = await client.sync(target({ review_screenshot: null })).catch((x: unknown) => x);
    expect((e as BillingSyncError).code).toBe('PROVIDER_REJECTED');
    expect(asc.writes).toEqual([]);
  });
  it('refuses an existing product of another period', async () => {
    asc.seedExisting();
    const e = await client.sync(target({ interval: 'YEAR' })).catch((x: unknown) => x);
    expect((e as BillingSyncError).message).toMatch(/ONE_MONTH, not ONE_YEAR/);
  });
});

describe('countries and currencies', () => {
  it('refuses a country the App Store does not sell in, and a currency mismatch', async () => {
    asc.seedExisting();
    await expect(client.sync(target({ prices: [{ country: 'ZZ', currency: 'USD', amount_minor: 1000 }] }))).rejects.toThrow(/does not sell in ZZ/);
    await expect(client.sync(target({ prices: [{ country: 'IN', currency: 'USD', amount_minor: 1000 }] }))).rejects.toThrow(/charges INR in IN/);
  });
});

describe('errors and credentials', () => {
  it('is dark without configuration', async () => {
    const dark = new AppleAscClient(null, asc.fetch);
    expect(dark.configured()).toBe(false);
    await expect(dark.sync(target())).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(appleAscConfig({})).toBeNull();
    expect(appleAscConfig({ CCP_ASC_API_ISSUER_ID: 'i', CCP_ASC_API_KEY_ID: 'k', CCP_ASC_API_PRIVATE_KEY_B64: Buffer.from('nope').toString('base64'), CCP_ASC_APP_ID: 'a', CCP_ASC_SUBSCRIPTION_GROUP_ID: 'g' })).toBeNull();
    expect(appleAscConfig({ CCP_ASC_API_ISSUER_ID: 'i', CCP_ASC_API_KEY_ID: 'k', CCP_ASC_API_PRIVATE_KEY_B64: Buffer.from(config.private_key_pem).toString('base64'), CCP_ASC_APP_ID: 'a', CCP_ASC_SUBSCRIPTION_GROUP_ID: 'g' })).not.toBeNull();
  });
  it('maps throttling to a retryable error and a 409 to a person', async () => {
    asc.seedExisting();
    asc.failNext = { status: 429, body: '{"errors":[]}' };
    await expect(client.sync(target())).rejects.toMatchObject({ code: 'TRANSIENT', retryable: true });
    asc.failNext = { status: 409, body: '{"errors":[{"detail":"description too long"}]}' };
    await expect(client.sync(target())).rejects.toMatchObject({ code: 'PROVIDER_REJECTED', retryable: false });
  });
  it('signs an ES256 team-key token for appstoreconnect-v1 and reuses it', async () => {
    asc.seedExisting();
    await client.sync(target());
    const tok = asc.tokens[0]!;
    expect(new Set(asc.tokens).size).toBe(1);
    expect(decodeProtectedHeader(tok)).toMatchObject({ alg: 'ES256', kid: 'TESTKEY123', typ: 'JWT' });
    const pub = await importSPKI(ec.publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'ES256');
    const { payload } = await jwtVerify(tok, pub, { audience: 'appstoreconnect-v1', issuer: config.issuer_id, currentDate: new Date(NOW) });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(900);
  });
});

describe('an approved App Store listing (approved-listing directive, prod 2026-11-17)', () => {
  const v5 = { display_name: 'Personal Standard', description: '50 sends a month' };
  const approve = (state: string) => {
    asc.seedExisting();
    const s = asc.subs.get(SUB)!;
    s.state = 'APPROVED';
    s.loc = { id: 'f909786b-loc', name: 'Personal - Standard', description: '25 sends a month', state };
  };

  it('keeps the approved text without a PATCH, still sets the price, and is SYNCED with a note', async () => {
    approve('APPROVED');
    const out = await client.sync(target(v5));
    expect(out).toMatchObject({ status: 'SYNCED', origin: 'ADOPTED', store_state: 'APPROVED' });
    expect(out.detail).toBe(
      'App Store text not changed: Apple\'s approved listing reads "Personal - Standard" / "25 sends a month", the catalog says "Personal Standard" / "50 sends a month". Change it in App Store Connect; it goes to Apple with the next app version.',
    );
    expect(asc.writes.some((w) => w.startsWith('PATCH /v1/subscriptionLocalizations'))).toBe(false);
    const s = asc.subs.get(SUB)!;
    expect(s.loc).toMatchObject({ name: 'Personal - Standard', description: '25 sends a month' });
    expect(s.scheduled?.['USA']).toEqual([{ pid: point(SUB, 'USA', '10128'), startDate: '2026-11-12' }]);
  });

  it('treats a 409 UNMODIFIABLE on PATCH (another locked state) the same way', async () => {
    approve('WAITING_FOR_REVIEW');
    const out = await client.sync(target(v5));
    expect(out.status).toBe('SYNCED');
    expect(out.detail).toMatch(/^App Store text not changed/);
    expect(asc.writes).toContain('PATCH /v1/subscriptionLocalizations/f909786b-loc');
    expect(asc.subs.get(SUB)!.scheduled?.['USA']?.[0]?.pid).toBe(point(SUB, 'USA', '10128'));
  });

  it('adds no note when the approved text already matches the catalog', async () => {
    approve('APPROVED');
    const out = await client.sync(target({ display_name: 'Personal - Standard', description: '25 sends a month' }));
    expect(out.detail).toBeNull();
  });

  it('still edits an editable listing, and a different 409 is still a person', async () => {
    asc.seedExisting();
    const out = await client.sync(target(v5));
    expect(asc.subs.get(SUB)!.loc).toMatchObject({ name: 'Personal Standard', description: '50 sends a month' });
    expect(out.detail).not.toMatch(/App Store text not changed/);

    const other = new FakeAsc();
    other.seedExisting();
    const realFetch = other.fetch;
    other.fetch = async (url, init) =>
      (init?.method ?? 'GET').toUpperCase() === 'PATCH'
        ? new Response(JSON.stringify({ errors: [{ status: '409', code: 'ENTITY_ERROR.ATTRIBUTE.INVALID', detail: 'x' }] }), { status: 409 })
        : realFetch(url, init);
    const c2 = new AppleAscClient(config, other.fetch, () => NOW);
    const err = await c2.sync(target(v5)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillingSyncError);
    expect((err as BillingSyncError).code).toBe('PROVIDER_REJECTED');
  });
});

describe('a price change on an approved App Store product (approved-listing directive A1, prod 2026-11-17)', () => {
  const approvedAt10 = () => {
    asc.seedExisting();
    const s = asc.subs.get(SUB)!;
    s.state = 'APPROVED';
    s.prices = { USA: point(SUB, 'USA', '10128'), IND: point(SUB, 'IND', '20002') };
    s.loc = { id: 'f909786b-loc', name: 'Standard', description: '25 sends a month and 1 GB storage', state: 'APPROVED' };
  };
  const at = (usd: number, inr: number) => target({ prices: [{ country: 'US', currency: 'USD', amount_minor: usd }, { country: 'IN', currency: 'INR', amount_minor: inr }], stop_countries: [] });

  it('schedules the change from tomorrow (UTC) for everyone, never a second initial price', async () => {
    approvedAt10();
    const out = await client.sync(at(999, 49900));
    expect(out.status).toBe('SYNCED');
    expect(asc.priceBodies).toEqual([
      { territory: 'USA', startDate: '2026-11-12', preserveCurrentPrice: false },
      { territory: 'IND', startDate: '2026-11-12', preserveCurrentPrice: false },
    ]);
    const s = asc.subs.get(SUB)!;
    expect(s.prices['USA']).toBe(point(SUB, 'USA', '10128'));
    expect(s.scheduled?.['USA']).toEqual([{ pid: point(SUB, 'USA', '10127'), startDate: '2026-11-12' }]);
  });

  it('is idempotent: a retry with the change already scheduled writes no price', async () => {
    approvedAt10();
    await client.sync(at(999, 49900));
    asc.priceBodies = [];
    await client.sync(at(999, 49900));
    expect(asc.priceBodies).toEqual([]);
  });

  it('writes nothing when the approved price already matches', async () => {
    approvedAt10();
    await client.sync(at(1000, 99900));
    expect(asc.priceBodies).toEqual([]);
  });

  it('keeps the immediate price for a product Apple has not approved yet', async () => {
    asc.seedExisting();
    await client.sync(target());
    expect(asc.priceBodies).toEqual([{ territory: 'USA', startDate: null, preserveCurrentPrice: false }]);
    expect(asc.subs.get(SUB)!.prices['USA']).toBe(point(SUB, 'USA', '10128'));
  });
});
