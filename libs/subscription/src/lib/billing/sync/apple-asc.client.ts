import { createHash } from 'node:crypto';

import { SignJWT, importPKCS8 } from 'jose';

import { wirePricePointAmount } from './apple-asc-wire.js';
import { appleTerritory, countryOfAppleTerritory } from './apple-territories.js';
import {
  BillingSyncError,
  httpSyncError,
  type BillingProductSyncPort,
  type BillingSyncOutcome,
  type BillingSyncTarget,
  type LiveProviderPrice,
  type PreviewProviderPrice,
  type SyncFetch,
  dropRefusal,
  unconfirmedDrops,
} from './billing-sync.port.js';
import { decimalToMinor } from './money.js';

// CCP Billing Products Directive v1.0 (LOCKED) §3.2-2, BP-4 / BP-5 / BP-7 — the App Store Connect API
// client (api.appstoreconnect.apple.com, ES256 team-key JWT, aud appstoreconnect-v1). Endpoints and
// shapes per Apple's App Store Connect OpenAPI specification 4.6 and verified read-only against the live
// app on 2026-11-11:
//   find      GET  /v1/subscriptionGroups/{group}/subscriptions?filter[productId]=   (adopt, BP-4)
//   create    POST /v1/subscriptions                       (familySharable false, BP-7)
//   text      GET  /v1/subscriptions/{id}/subscriptionLocalizations, POST / PATCH /v1/subscriptionLocalizations
//   prices    GET  /v1/subscriptions/{id}/pricePoints?filter[territory]=   (exact point, BP-5: never rounded)
//             GET  /v1/subscriptions/{id}/prices?filter[territory]=&include=subscriptionPricePoint
//             POST /v1/subscriptionPrices                  (only when the current point differs)
//   countries GET  /v1/subscriptions/{id}/planAvailabilities, POST / PATCH /v1/subscriptionPlanAvailabilities
//             (the non-deprecated availability resource; exactly the catalog's countries, no new territories)
//   review    GET  /v1/subscriptions/{id}/appStoreReviewScreenshot, DELETE + POST + upload + PATCH
//             /v1/subscriptionAppStoreReviewScreenshots (only when the file's MD5 differs)
// Sending the subscription to Apple for review stays manual (BP-7): the outcome carries Apple's state.
// Never logs the key or the token.

export const ASC_API = 'https://api.appstoreconnect.apple.com';

export interface AppleAscConfig {
  issuer_id: string;
  key_id: string;
  private_key_pem: string;
  app_id: string;
  subscription_group_id: string;
}

const env = (e: NodeJS.ProcessEnv, k: string): string | null => {
  const v = e[k]?.trim();
  return v === undefined || v === '' ? null : v;
};

/** BP-13 — CCP_ASC_* (platform-admin only); null when any value is missing or malformed (Apple sync off). */
export function appleAscConfig(e: NodeJS.ProcessEnv = process.env): AppleAscConfig | null {
  const issuer_id = env(e, 'CCP_ASC_API_ISSUER_ID');
  const key_id = env(e, 'CCP_ASC_API_KEY_ID');
  const keyB64 = env(e, 'CCP_ASC_API_PRIVATE_KEY_B64');
  const app_id = env(e, 'CCP_ASC_APP_ID');
  const subscription_group_id = env(e, 'CCP_ASC_SUBSCRIPTION_GROUP_ID');
  if (issuer_id === null || key_id === null || keyB64 === null || app_id === null || subscription_group_id === null) return null;
  let private_key_pem: string;
  try {
    private_key_pem = Buffer.from(keyB64, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!private_key_pem.includes('PRIVATE KEY')) return null;
  return { issuer_id, key_id, private_key_pem, app_id, subscription_group_id };
}

interface Resource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string; type: string } | { id: string; type: string }[] | null }>;
}
interface Doc {
  data?: Resource | Resource[] | null;
  included?: Resource[];
  links?: { next?: string };
}

const PERIOD = { MONTH: 'ONE_MONTH', YEAR: 'ONE_YEAR' } as const;
const LOCALE = 'en-US';
/** Apple's reference name limit (internal name, never shown to buyers). */
const REFERENCE_NAME_MAX = 64;

export class AppleAscClient implements BillingProductSyncPort {
  readonly provider = 'APP_STORE' as const;
  private cached: { token: string; expires_at: number } | null = null;

  constructor(
    private readonly config: AppleAscConfig | null,
    private readonly fetchImpl: SyncFetch = (url, init) => fetch(url, init),
    private readonly clock: () => number = () => Date.now(),
  ) {}

  configured(): boolean {
    return this.config !== null;
  }

  async sync(t: BillingSyncTarget): Promise<BillingSyncOutcome> {
    const cfg = this.need();
    const territories = territoriesOf(t);
    let sub = await this.findSubscription(cfg, t.product_id, t.known_external_ref);
    let origin: BillingSyncOutcome['origin'] = sub === null ? 'CREATED' : t.known_external_ref === null ? 'ADOPTED' : 'EXISTING';
    if (sub === null) {
      if (t.review_screenshot === null) throw new BillingSyncError('PROVIDER_REJECTED', 'a new App Store product needs the review screenshot', false);
      sub = await this.createSubscription(cfg, t);
      origin = 'CREATED';
    } else if (sub.attributes?.['subscriptionPeriod'] !== PERIOD[t.interval]) {
      throw new BillingSyncError('PROVIDER_REJECTED', `App Store product ${t.product_id} is ${String(sub.attributes?.['subscriptionPeriod'])}, not ${PERIOD[t.interval]}`, false);
    }
    // A1-2 — never narrow the countries silently: refuse before any write when a live country has no price.
    const drops = unconfirmedDrops(await this.availableCountries(sub.id), t);
    if (drops.length > 0) throw dropRefusal('The App Store', drops);
    await this.syncLocalization(sub.id, t);
    for (const p of territories) await this.syncPrice(sub.id, p);
    await this.syncAvailability(sub.id, territories.map((p) => p.territory));
    if (t.review_screenshot !== null) await this.syncScreenshot(sub.id, t.review_screenshot);
    const now = await this.get(`/v1/subscriptions/${enc(sub.id)}`);
    const state = str(one(now)?.attributes?.['state']);
    return {
      status: 'SYNCED',
      origin,
      external_ref: sub.id,
      external_price_ref: null,
      store_state: state,
      detail: state === 'APPROVED' ? null : `App Store state ${state ?? 'unknown'}: sending the subscription to Apple for review is a manual step in App Store Connect`,
    };
  }

  async preview(t: BillingSyncTarget): Promise<PreviewProviderPrice[]> {
    const cfg = this.need();
    const territories = territoriesOf(t);
    // Price points belong to a subscription: use this product's, or (not created yet) any product of the group.
    const sub = (await this.findSubscription(cfg, t.product_id, t.known_external_ref)) ?? (await this.anySubscription(cfg));
    if (sub === null) {
      return territories.map((p) => ({ country: p.country, currency: p.currency, amount_minor: p.amount_minor, available: false, nearest: [] }));
    }
    const out: PreviewProviderPrice[] = [];
    for (const p of territories) {
      const points = await this.pricePoints(sub.id, p.territory, p.currency);
      const exact = points.find((x) => x.amount_minor === p.amount_minor);
      out.push({ country: p.country, currency: p.currency, amount_minor: p.amount_minor, available: exact !== undefined, nearest: exact !== undefined ? [] : nearestOf(points.map((x) => x.amount_minor), p.amount_minor) });
    }
    return out;
  }

  async livePrices(t: Pick<BillingSyncTarget, 'provider' | 'interval' | 'product_id' | 'known_external_ref' | 'prices'>): Promise<LiveProviderPrice[]> {
    const cfg = this.need();
    const sub = await this.findSubscription(cfg, t.product_id, t.known_external_ref);
    const out: LiveProviderPrice[] = [];
    for (const p of t.prices) {
      const terr = appleTerritory(p.country);
      if (terr === null || sub === null) {
        out.push({ country: p.country, currency: p.currency, amount_minor: null });
        continue;
      }
      const cur = await this.currentPrice(sub.id, terr.territory);
      out.push({ country: p.country, currency: terr.currency, amount_minor: cur === null ? null : decimalToMinor(cur.amount, terr.currency) });
    }
    return out;
  }

  // ---- steps -------------------------------------------------------------------------------

  private async findSubscription(cfg: AppleAscConfig, product_id: string, known: string | null): Promise<Resource | null> {
    if (known !== null) {
      const d = await this.get(`/v1/subscriptions/${enc(known)}`, true);
      const r = d === null ? null : one(d);
      if (r !== null && r.attributes?.['productId'] === product_id) return r;
    }
    const d = await this.get(`/v1/subscriptionGroups/${enc(cfg.subscription_group_id)}/subscriptions?filter%5BproductId%5D=${enc(product_id)}&limit=1`);
    return many(d).find((r) => r.attributes?.['productId'] === product_id) ?? null;
  }

  private async anySubscription(cfg: AppleAscConfig): Promise<Resource | null> {
    const d = await this.get(`/v1/subscriptionGroups/${enc(cfg.subscription_group_id)}/subscriptions?limit=1`);
    return many(d)[0] ?? null;
  }

  private async createSubscription(cfg: AppleAscConfig, t: BillingSyncTarget): Promise<Resource> {
    const name = `${t.display_name} ${t.interval === 'MONTH' ? 'Monthly' : 'Yearly'}`.slice(0, REFERENCE_NAME_MAX);
    const d = await this.send('POST', '/v1/subscriptions', {
      data: {
        type: 'subscriptions',
        attributes: { name, productId: t.product_id, subscriptionPeriod: PERIOD[t.interval], familySharable: false },
        relationships: { group: { data: { type: 'subscriptionGroups', id: cfg.subscription_group_id } } },
      },
    });
    const r = one(d);
    if (r === null) throw new BillingSyncError('TRANSIENT', 'App Store Connect created no subscription resource');
    return r;
  }

  private async syncLocalization(subId: string, t: BillingSyncTarget): Promise<void> {
    const list = many(await this.get(`/v1/subscriptions/${enc(subId)}/subscriptionLocalizations?limit=50`));
    const en = list.find((l) => l.attributes?.['locale'] === LOCALE);
    if (en === undefined) {
      await this.send('POST', '/v1/subscriptionLocalizations', {
        data: {
          type: 'subscriptionLocalizations',
          attributes: { locale: LOCALE, name: t.display_name, description: t.description },
          relationships: { subscription: { data: { type: 'subscriptions', id: subId } } },
        },
      });
      return;
    }
    if (en.attributes?.['name'] === t.display_name && en.attributes?.['description'] === t.description) return;
    await this.send('PATCH', `/v1/subscriptionLocalizations/${enc(en.id)}`, {
      data: { type: 'subscriptionLocalizations', id: en.id, attributes: { name: t.display_name, description: t.description } },
    });
  }

  private async syncPrice(subId: string, p: TerritoryPrice): Promise<void> {
    const points = await this.pricePoints(subId, p.territory, p.currency);
    const exact = points.find((x) => x.amount_minor === p.amount_minor);
    if (exact === undefined) {
      const near = nearestOf(points.map((x) => x.amount_minor), p.amount_minor);
      throw new BillingSyncError('PRICE_POINT_UNAVAILABLE', `the App Store has no ${p.currency} price point of exactly ${p.amount_minor} (minor units) in ${p.country}; nearest: ${near.join(', ') || 'none'}`, false);
    }
    const cur = await this.currentPrice(subId, p.territory);
    if (cur !== null && cur.point_id === exact.id) return;
    await this.send('POST', '/v1/subscriptionPrices', {
      data: {
        type: 'subscriptionPrices',
        attributes: { startDate: null, preserveCurrentPrice: false },
        relationships: {
          subscription: { data: { type: 'subscriptions', id: subId } },
          subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: exact.id } },
          territory: { data: { type: 'territories', id: p.territory } },
        },
      },
    });
  }

  async liveCountries(t: BillingSyncTarget): Promise<string[] | null> {
    const cfg = this.need();
    const sub = await this.findSubscription(cfg, t.product_id, t.known_external_ref);
    return sub === null ? null : this.availableCountries(sub.id);
  }

  /** The countries a subscription is available in today (empty when it has no availability yet). */
  private async availableCountries(subId: string): Promise<string[]> {
    const av = await this.planAvailability(subId);
    return (av?.territories ?? []).map((id) => countryOfAppleTerritory(id) ?? id).sort();
  }

  /**
   * The subscription's plan availability and every territory it lists. Apple caps an included relationship
   * at 50 (`limit[availableTerritories]` > 50 is a 400), so the territories are read from the availability's
   * own relationship endpoint, page by page (up to 200 per page).
   */
  private async planAvailability(subId: string): Promise<{ id: string; availableInNewTerritories: unknown; territories: string[] } | null> {
    const current = many(await this.get(`/v1/subscriptions/${enc(subId)}/planAvailabilities`))[0];
    if (current === undefined) return null;
    const territories: string[] = [];
    let path: string | null = `/v1/subscriptionPlanAvailabilities/${enc(current.id)}/relationships/availableTerritories?limit=200`;
    for (let page = 0; path !== null && page < 20; page++) {
      const d: Doc = await this.get(path);
      for (const r of many(d)) territories.push(r.id);
      path = d.links?.next ? d.links.next.replace(ASC_API, '') : null;
    }
    return { id: current.id, availableInNewTerritories: current.attributes?.['availableInNewTerritories'], territories };
  }

  private async syncAvailability(subId: string, territories: string[]): Promise<void> {
    const current = await this.planAvailability(subId);
    const want = [...new Set(territories)].sort();
    const data = want.map((id) => ({ type: 'territories', id }));
    if (current === null) {
      await this.send('POST', '/v1/subscriptionPlanAvailabilities', {
        data: {
          type: 'subscriptionPlanAvailabilities',
          attributes: { availableInNewTerritories: false, planType: 'UPFRONT' },
          relationships: { subscription: { data: { type: 'subscriptions', id: subId } }, availableTerritories: { data } },
        },
      });
      return;
    }
    const have = [...current.territories].sort();
    if (current.availableInNewTerritories === false && have.join() === want.join()) return;
    await this.send('PATCH', `/v1/subscriptionPlanAvailabilities/${enc(current.id)}`, {
      data: { type: 'subscriptionPlanAvailabilities', id: current.id, attributes: { availableInNewTerritories: false }, relationships: { availableTerritories: { data } } },
    });
  }

  private async syncScreenshot(subId: string, shot: NonNullable<BillingSyncTarget['review_screenshot']>): Promise<void> {
    const md5 = createHash('md5').update(shot.bytes).digest('hex');
    const existing = one((await this.get(`/v1/subscriptions/${enc(subId)}/appStoreReviewScreenshot`, true)) ?? {});
    if (existing !== null && existing.attributes?.['sourceFileChecksum'] === md5) return;
    if (existing !== null) await this.send('DELETE', `/v1/subscriptionAppStoreReviewScreenshots/${enc(existing.id)}`);
    const created = one(
      await this.send('POST', '/v1/subscriptionAppStoreReviewScreenshots', {
        data: {
          type: 'subscriptionAppStoreReviewScreenshots',
          attributes: { fileName: shot.file_name, fileSize: shot.bytes.byteLength },
          relationships: { subscription: { data: { type: 'subscriptions', id: subId } } },
        },
      }),
    );
    if (created === null) throw new BillingSyncError('TRANSIENT', 'App Store Connect reserved no screenshot upload');
    const ops = (created.attributes?.['uploadOperations'] ?? []) as { method?: string; url?: string; offset?: number; length?: number; requestHeaders?: { name?: string; value?: string }[] }[];
    for (const op of ops) {
      const offset = op.offset ?? 0;
      const length = op.length ?? shot.bytes.byteLength - offset;
      const headers: Record<string, string> = {};
      for (const h of op.requestHeaders ?? []) if (h.name !== undefined && h.value !== undefined) headers[h.name] = h.value;
      const res = await this.fetchImpl(String(op.url), { method: op.method ?? 'PUT', headers, body: Buffer.from(shot.bytes.subarray(offset, offset + length)) });
      if (!res.ok) throw httpSyncError('App Store asset upload', res.status, await res.text());
    }
    await this.send('PATCH', `/v1/subscriptionAppStoreReviewScreenshots/${enc(created.id)}`, {
      data: { type: 'subscriptionAppStoreReviewScreenshots', id: created.id, attributes: { uploaded: true, sourceFileChecksum: md5 } },
    });
  }

  // ---- reads -------------------------------------------------------------------------------

  private async pricePoints(subId: string, territory: string, currency: string): Promise<{ id: string; amount_minor: number }[]> {
    const out: { id: string; amount_minor: number }[] = [];
    let path: string | null = `/v1/subscriptions/${enc(subId)}/pricePoints?filter%5Bterritory%5D=${enc(territory)}&limit=200`;
    for (let page = 0; path !== null && page < 50; page++) {
      const d: Doc = await this.get(path);
      for (const r of many(d)) {
        const amount = wirePricePointAmount(r.attributes);
        const minor = amount === null ? null : decimalToMinor(amount, currency);
        if (minor !== null) out.push({ id: r.id, amount_minor: minor });
      }
      path = d.links?.next ? d.links.next.replace(ASC_API, '') : null;
    }
    return out;
  }

  /** The price in effect today in a territory: its point id and amount, or null. */
  private async currentPrice(subId: string, territory: string): Promise<{ point_id: string; amount: string } | null> {
    const d = await this.get(`/v1/subscriptions/${enc(subId)}/prices?filter%5Bterritory%5D=${enc(territory)}&include=subscriptionPricePoint&limit=50`);
    const today = new Date(this.clock()).toISOString().slice(0, 10);
    const effective = many(d)
      .filter((p) => {
        const sd = p.attributes?.['startDate'];
        return sd === null || sd === undefined || String(sd) <= today;
      })
      .sort((a, b) => String(a.attributes?.['startDate'] ?? '').localeCompare(String(b.attributes?.['startDate'] ?? '')));
    const cur = effective[effective.length - 1];
    const rel = cur?.relationships?.['subscriptionPricePoint']?.data;
    if (cur === undefined || rel === undefined || rel === null || Array.isArray(rel)) return null;
    const point = (d.included ?? []).find((i) => i.type === 'subscriptionPricePoints' && i.id === rel.id);
    const amount = wirePricePointAmount(point?.attributes);
    return amount === null ? null : { point_id: rel.id, amount };
  }

  // ---- transport ---------------------------------------------------------------------------

  private need(): AppleAscConfig {
    if (this.config === null) throw new BillingSyncError('NOT_CONFIGURED', 'App Store Connect sync is not configured (CCP_ASC_*)', false);
    return this.config;
  }

  private async token(): Promise<string> {
    const cfg = this.need();
    const now = this.clock();
    if (this.cached !== null && this.cached.expires_at - 60_000 > now) return this.cached.token;
    const key = await importPKCS8(cfg.private_key_pem, 'ES256');
    const iat = Math.floor(now / 1000);
    const token = await new SignJWT({ aud: 'appstoreconnect-v1' })
      .setProtectedHeader({ alg: 'ES256', kid: cfg.key_id, typ: 'JWT' })
      .setIssuer(cfg.issuer_id)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 15 * 60)
      .sign(key);
    this.cached = { token, expires_at: now + 15 * 60_000 };
    return token;
  }

  private async get(path: string): Promise<Doc>;
  private async get(path: string, allowNotFound: true): Promise<Doc | null>;
  private async get(path: string, allowNotFound = false): Promise<Doc | null> {
    const res = await this.call('GET', path);
    if (res.status === 404 && allowNotFound) return null;
    return this.parse(res);
  }

  private async send(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<Doc> {
    return this.parse(await this.call(method, path, body));
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.token()}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await this.fetchImpl(`${ASC_API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new BillingSyncError('TRANSIENT', `App Store Connect unreachable: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }

  private async parse(res: Response): Promise<Doc> {
    const text = await res.text();
    if (!res.ok) throw httpSyncError('App Store Connect', res.status, text);
    if (text.trim() === '') return {};
    try {
      return JSON.parse(text) as Doc;
    } catch {
      throw new BillingSyncError('TRANSIENT', 'App Store Connect returned a non-JSON body');
    }
  }
}

interface TerritoryPrice {
  country: string;
  territory: string;
  currency: string;
  amount_minor: number;
}

/** The target's countries → App Store territories; a country the App Store does not sell in, or a currency mismatch, is refused. */
function territoriesOf(t: BillingSyncTarget): TerritoryPrice[] {
  return t.prices.map((p) => {
    const terr = appleTerritory(p.country);
    if (terr === null) throw new BillingSyncError('PROVIDER_REJECTED', `the App Store does not sell in ${p.country}`, false);
    if (terr.currency !== p.currency) throw new BillingSyncError('PROVIDER_REJECTED', `the App Store charges ${terr.currency} in ${p.country}, the catalog price is ${p.currency}`, false);
    return { country: p.country, territory: terr.territory, currency: terr.currency, amount_minor: p.amount_minor };
  });
}

/** The closest available amounts below and above (at most one each). */
export function nearestOf(available: number[], amount: number): number[] {
  const below = available.filter((a) => a < amount).sort((a, b) => b - a)[0];
  const above = available.filter((a) => a > amount).sort((a, b) => a - b)[0];
  return [below, above].filter((x): x is number => x !== undefined);
}

const enc = encodeURIComponent;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
function one(d: Doc): Resource | null {
  return d.data !== undefined && d.data !== null && !Array.isArray(d.data) ? d.data : null;
}
function many(d: Doc): Resource[] {
  return Array.isArray(d.data) ? d.data : [];
}
