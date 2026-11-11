import { googleMoneyMinor, googleServiceAccountToken } from '../store/google-play.adapter.js';
import type { GooglePlayConfig } from '../store/store-billing.config.js';

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
import { currencyExponent } from './money.js';

// CCP Billing Products Directive v1.0 (LOCKED) §3.2-3, BP-8 — the Google Play writer (Android Publisher
// v3 monetization.subscriptions). Built console-first: no Play product is ever created by hand; the first
// one is created here.
//   find     GET   applications/{pkg}/subscriptions/{productId}
//   create   POST  applications/{pkg}/subscriptions?productId=&regionsVersion.version=2022/02
//   update   PATCH applications/{pkg}/subscriptions/{productId}?updateMask=listings,basePlans&regionsVersion.version=2022/02
//   activate POST  …/subscriptions/{productId}/basePlans/{basePlanId}:activate
// One base plan per interval (`monthly` / `yearly`). Regions = exactly the catalog's countries at the
// exact catalog amount (BP-5); a region Play already has that the catalog no longer sells in is kept with
// newSubscriberAvailability false (Play does not remove a region). Dark until SIGN_GOOGLE_PLAY_* is set.

const PUBLISHER = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const REGIONS_VERSION = 'regionsVersion.version=2022%2F02';
const BASE_PLAN = { MONTH: 'monthly', YEAR: 'yearly' } as const;
const PERIOD = { MONTH: 'P1M', YEAR: 'P1Y' } as const;

interface PlayMoney {
  currencyCode?: string;
  units?: string;
  nanos?: number;
}
interface PlayRegionalConfig {
  regionCode?: string;
  newSubscriberAvailability?: boolean;
  price?: PlayMoney;
}
interface PlayBasePlan {
  basePlanId?: string;
  state?: string;
  autoRenewingBasePlanType?: { billingPeriodDuration?: string };
  regionalConfigs?: PlayRegionalConfig[];
  [k: string]: unknown;
}
interface PlaySubscription {
  packageName?: string;
  productId?: string;
  listings?: { languageCode?: string; title?: string; description?: string; benefits?: string[] }[];
  basePlans?: PlayBasePlan[];
  [k: string]: unknown;
}

export class GooglePlayWriter implements BillingProductSyncPort {
  readonly provider = 'GOOGLE_PLAY' as const;
  private cached: { token: string; expires_at: number } | null = null;

  constructor(
    private readonly config: GooglePlayConfig | null,
    private readonly fetchImpl: SyncFetch = (url, init) => fetch(url, init),
    private readonly clock: () => number = () => Date.now(),
  ) {}

  configured(): boolean {
    return this.config !== null;
  }

  async sync(t: BillingSyncTarget): Promise<BillingSyncOutcome> {
    const cfg = this.need();
    const basePlanId = BASE_PLAN[t.interval];
    const existing = await this.getSub(cfg, t.product_id);
    const want = regionalConfigsOf(t);
    let origin: BillingSyncOutcome['origin'];
    let sub: PlaySubscription;
    if (existing === null) {
      sub = await this.send('POST', `${base(cfg)}/subscriptions?productId=${enc(t.product_id)}&${REGIONS_VERSION}`, {
        packageName: cfg.package_name,
        productId: t.product_id,
        listings: [{ languageCode: 'en-US', title: t.display_name, description: t.description }],
        basePlans: [{ basePlanId, autoRenewingBasePlanType: { billingPeriodDuration: PERIOD[t.interval] }, regionalConfigs: want }],
      });
      origin = 'CREATED';
    } else {
      origin = t.known_external_ref === null ? 'ADOPTED' : 'EXISTING';
      const plans = existing.basePlans ?? [];
      const current = plans.find((b) => b.basePlanId === basePlanId);
      if (current !== undefined && current.autoRenewingBasePlanType?.billingPeriodDuration !== PERIOD[t.interval]) {
        throw new BillingSyncError('PROVIDER_REJECTED', `Play base plan ${basePlanId} of ${t.product_id} is not ${PERIOD[t.interval]}`, false);
      }
      // A1-2 — never narrow the countries silently: a region open to new subscribers needs a price or a confirmed stop.
      const drops = unconfirmedDrops(openRegions(current), t);
      if (drops.length > 0) throw dropRefusal('Google Play', drops);
      const regions = mergeRegions(current?.regionalConfigs ?? [], want);
      const listing = (existing.listings ?? []).find((l) => l.languageCode === 'en-US');
      const listingsOk = listing !== undefined && listing.title === t.display_name && (listing.description ?? '') === t.description;
      const regionsOk = current !== undefined && sameRegions(current.regionalConfigs ?? [], regions);
      if (listingsOk && regionsOk) {
        sub = existing;
      } else {
        const listings = [...(existing.listings ?? []).filter((l) => l.languageCode !== 'en-US'), { ...(listing ?? {}), languageCode: 'en-US', title: t.display_name, description: t.description }];
        const basePlans = current === undefined
          ? [...plans, { basePlanId, autoRenewingBasePlanType: { billingPeriodDuration: PERIOD[t.interval] }, regionalConfigs: regions }]
          : plans.map((b) => (b.basePlanId === basePlanId ? { ...b, regionalConfigs: regions } : b));
        sub = await this.send('PATCH', `${base(cfg)}/subscriptions/${enc(t.product_id)}?updateMask=listings,basePlans&${REGIONS_VERSION}`, { ...existing, listings, basePlans });
      }
    }
    const plan = (sub.basePlans ?? []).find((b) => b.basePlanId === basePlanId);
    let state = plan?.state ?? null;
    if (state !== 'ACTIVE') {
      const activated = await this.send('POST', `${base(cfg)}/subscriptions/${enc(t.product_id)}/basePlans/${basePlanId}:activate`, {});
      state = (activated.basePlans ?? []).find((b) => b.basePlanId === basePlanId)?.state ?? 'ACTIVE';
    }
    return { status: 'SYNCED', origin, external_ref: null, external_price_ref: null, store_state: state, detail: null };
  }

  async preview(t: BillingSyncTarget): Promise<PreviewProviderPrice[]> {
    // Play takes any amount in a region's currency: each catalog price is exactly available.
    return t.prices.map((p) => ({ country: p.country, currency: p.currency, amount_minor: p.amount_minor, available: true, nearest: [] }));
  }

  async liveCountries(t: BillingSyncTarget): Promise<string[] | null> {
    const cfg = this.need();
    const sub = await this.getSub(cfg, t.product_id);
    if (sub === null) return null;
    return openRegions((sub.basePlans ?? []).find((b) => b.basePlanId === BASE_PLAN[t.interval]));
  }

  async livePrices(t: Pick<BillingSyncTarget, 'provider' | 'interval' | 'product_id' | 'known_external_ref' | 'prices' | 'plan_version_id'>): Promise<LiveProviderPrice[]> {
    const cfg = this.need();
    const sub = await this.getSub(cfg, t.product_id);
    const plan = (sub?.basePlans ?? []).find((b) => b.basePlanId === BASE_PLAN[t.interval]);
    return t.prices.map((p) => {
      const rc = (plan?.regionalConfigs ?? []).find((r) => r.regionCode === p.country);
      const minor = rc?.price === undefined ? null : googleMoneyMinor(rc.price);
      return { country: p.country, currency: rc?.price?.currencyCode ?? p.currency, amount_minor: minor };
    });
  }

  // ---- transport ---------------------------------------------------------------------------

  private need(): GooglePlayConfig {
    if (this.config === null) throw new BillingSyncError('NOT_CONFIGURED', 'Google Play sync is not configured (SIGN_GOOGLE_PLAY_*)', false);
    return this.config;
  }

  private async getSub(cfg: GooglePlayConfig, product_id: string): Promise<PlaySubscription | null> {
    const res = await this.call('GET', `${base(cfg)}/subscriptions/${enc(product_id)}`);
    if (res.status === 404) return null;
    return this.parse(res);
  }

  private async send(method: 'POST' | 'PATCH', url: string, body: unknown): Promise<PlaySubscription> {
    return this.parse(await this.call(method, url, body));
  }

  private async call(method: string, url: string, body?: unknown): Promise<Response> {
    const cfg = this.need();
    const now = this.clock();
    if (this.cached === null || this.cached.expires_at <= now) {
      try {
        this.cached = await googleServiceAccountToken(cfg.credentials, this.fetchImpl, now, 15_000);
      } catch (e) {
        throw new BillingSyncError('NOT_CONFIGURED', `Google Play credential unavailable: ${(e as Error).message.slice(0, 60)}`, false);
      }
    }
    const headers: Record<string, string> = { authorization: `Bearer ${this.cached.token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await this.fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new BillingSyncError('TRANSIENT', `Google Play unreachable: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }

  private async parse(res: Response): Promise<PlaySubscription> {
    const text = await res.text();
    if (!res.ok) throw httpSyncError('Google Play', res.status, text);
    try {
      return (text.trim() === '' ? {} : JSON.parse(text)) as PlaySubscription;
    } catch {
      throw new BillingSyncError('TRANSIENT', 'Google Play returned a non-JSON body');
    }
  }
}

/** The catalog's prices → Play regional configs (exact Money; open to new subscribers). */
export function regionalConfigsOf(t: Pick<BillingSyncTarget, 'prices'>): PlayRegionalConfig[] {
  return t.prices.map((p) => ({ regionCode: p.country, newSubscriberAvailability: true, price: minorToMoney(p.amount_minor, p.currency) }));
}

/** The regions of a base plan open to new subscribers. */
function openRegions(plan: { regionalConfigs?: PlayRegionalConfig[] } | undefined): string[] {
  return (plan?.regionalConfigs ?? []).filter((r) => r.newSubscriberAvailability !== false).map((r) => String(r.regionCode)).sort();
}

/** Keep every region Play has; the catalog's set the exact price and open them; the rest close to new subscribers. */
export function mergeRegions(have: PlayRegionalConfig[], want: PlayRegionalConfig[]): PlayRegionalConfig[] {
  const wanted = new Map(want.map((w) => [w.regionCode, w]));
  const kept = have.filter((h) => !wanted.has(h.regionCode)).map((h) => ({ ...h, newSubscriberAvailability: false }));
  return [...want, ...kept].sort((a, b) => String(a.regionCode).localeCompare(String(b.regionCode)));
}

function sameRegions(a: PlayRegionalConfig[], b: PlayRegionalConfig[]): boolean {
  const key = (r: PlayRegionalConfig) => `${r.regionCode}|${r.newSubscriberAvailability !== false}|${r.price?.currencyCode}|${googleMoneyMinor(r.price ?? {})}`;
  return [...a].map(key).sort().join() === [...b].map(key).sort().join();
}

export function minorToMoney(amount_minor: number, currency: string): PlayMoney {
  const exp = currencyExponent(currency);
  const units = Math.trunc(amount_minor / 10 ** exp);
  const rest = amount_minor - units * 10 ** exp;
  return { currencyCode: currency, units: String(units), nanos: Math.round(rest * 10 ** (9 - exp)) };
}

const base = (cfg: GooglePlayConfig) => `${PUBLISHER}/${encodeURIComponent(cfg.package_name)}`;
const enc = encodeURIComponent;
