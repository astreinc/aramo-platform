import { STRIPE_API_VERSION, stripeApiBase, stripeSecretKey } from '../stripe-billing.provider.js';

import {
  BillingSyncError,
  httpSyncError,
  type BillingProductSyncPort,
  type BillingSyncOutcome,
  type BillingSyncTarget,
  type LiveProviderPrice,
  type PreviewProviderPrice,
  type SyncFetch,
} from './billing-sync.port.js';

// CCP Billing Products Directive v1.0 (LOCKED) §3.2-1, BP-9 — the Stripe catalog writer. One Stripe
// Product per plan (Aramo's own product id, so create-or-adopt is a GET), one Stripe Price per published
// version price (lookup_key = the version + interval, idempotency key per version, so a retry never makes
// a second price). Stripe sells on the web in the US only (plan-version.ts regional_prices note): the
// target's US price is the price; regional prices are not sent to Stripe. Uses the existing
// Stripe key and API base through the Stripe adapter's own readers (test key until live Stripe is
// separately authorized; the CCP-C5 guard keeps key readers to the adapters). No tax parameter is sent.
// Never logs the key.

interface StripeObj {
  id?: string;
  name?: string;
  description?: string | null;
  active?: boolean;
  unit_amount?: number | null;
  currency?: string;
  product?: string;
  recurring?: { interval?: string } | null;
  data?: StripeObj[];
}

const INTERVAL = { MONTH: 'month', YEAR: 'year' } as const;

export class StripeCatalogWriter implements BillingProductSyncPort {
  readonly provider = 'STRIPE' as const;

  constructor(
    private readonly fetchImpl: SyncFetch = (url, init) => fetch(url, init),
    private readonly transport: { key: () => string | undefined; base: () => string } = { key: stripeSecretKey, base: stripeApiBase },
  ) {}

  configured(): boolean {
    return this.key() !== null;
  }

  async sync(t: BillingSyncTarget): Promise<BillingSyncOutcome> {
    const us = usPrice(t);
    const existing = await this.get(`/v1/products/${enc(t.product_id)}`, true);
    let origin: BillingSyncOutcome['origin'];
    if (existing === null) {
      await this.post('/v1/products', {
        id: t.product_id,
        name: t.display_name,
        description: t.description,
        'metadata[aramo_plan_id]': t.plan_id,
        'metadata[aramo_plan_key]': t.plan_key,
      }, `ccp-product-${t.product_id}`);
      origin = 'CREATED';
    } else {
      origin = t.known_external_ref === null ? 'ADOPTED' : 'EXISTING';
      if (existing.name !== t.display_name || (existing.description ?? '') !== t.description || existing.active === false) {
        await this.post(`/v1/products/${enc(t.product_id)}`, { name: t.display_name, description: t.description, active: 'true' });
      }
    }
    const lookup = lookupKey(t.plan_version_id, t.interval);
    const found = (await this.get(`/v1/prices?lookup_keys%5B%5D=${enc(lookup)}&limit=1`))?.data?.[0];
    let price = found;
    if (price !== undefined && !(price.product === t.product_id && price.unit_amount === us.amount_minor && price.currency === 'usd' && price.recurring?.interval === INTERVAL[t.interval])) {
      throw new BillingSyncError('PROVIDER_REJECTED', `Stripe price ${lookup} exists with different terms; a published version's price is immutable`, false);
    }
    if (price === undefined) {
      price = await this.post('/v1/prices', {
        product: t.product_id,
        currency: 'usd',
        unit_amount: String(us.amount_minor),
        'recurring[interval]': INTERVAL[t.interval],
        lookup_key: lookup,
        'metadata[aramo_plan_version_id]': t.plan_version_id,
        'metadata[aramo_version_number]': String(t.version_number),
      }, `ccp-price-${lookup}`);
    }
    if (typeof price.id !== 'string') throw new BillingSyncError('TRANSIENT', 'Stripe returned no price id');
    return { status: 'SYNCED', origin, external_ref: null, external_price_ref: price.id, store_state: null, detail: null };
  }

  async preview(t: BillingSyncTarget): Promise<PreviewProviderPrice[]> {
    const us = usPrice(t);
    return [{ country: 'US', currency: 'USD', amount_minor: us.amount_minor, available: true, nearest: [] }];
  }

  /** Stripe sells on the web at the US price only; it has no per-country availability to narrow. */
  async liveCountries(): Promise<string[] | null> {
    return null;
  }

  async livePrices(t: Pick<BillingSyncTarget, 'provider' | 'interval' | 'product_id' | 'known_external_ref' | 'prices' | 'plan_version_id'>): Promise<LiveProviderPrice[]> {
    const price = (await this.get(`/v1/prices?lookup_keys%5B%5D=${enc(lookupKey(t.plan_version_id, t.interval))}&limit=1`))?.data?.[0];
    return [{ country: 'US', currency: 'USD', amount_minor: typeof price?.unit_amount === 'number' && price.currency === 'usd' ? price.unit_amount : null }];
  }

  // ---- transport ---------------------------------------------------------------------------

  private key(): string | null {
    return this.transport.key() ?? null;
  }

  private base(): string {
    return this.transport.base();
  }

  private async get(path: string, allowNotFound = false): Promise<StripeObj | null> {
    const res = await this.call('GET', path);
    if (res.status === 404 && allowNotFound) return null;
    return this.parse(res);
  }

  private async post(path: string, params: Record<string, string>, idempotency?: string): Promise<StripeObj> {
    const res = await this.call('POST', path, new URLSearchParams(params).toString(), idempotency);
    return (await this.parse(res)) ?? {};
  }

  private async call(method: string, path: string, body?: string, idempotency?: string): Promise<Response> {
    const key = this.key();
    if (key === null) throw new BillingSyncError('NOT_CONFIGURED', 'Stripe sync is not configured (STRIPE_SECRET_KEY)', false);
    const headers: Record<string, string> = { authorization: `Bearer ${key}`, 'stripe-version': STRIPE_API_VERSION };
    if (body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (idempotency !== undefined) headers['idempotency-key'] = idempotency;
    try {
      return await this.fetchImpl(`${this.base()}${path}`, { method, headers, body });
    } catch (e) {
      throw new BillingSyncError('TRANSIENT', `Stripe unreachable: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }

  private async parse(res: Response): Promise<StripeObj | null> {
    const text = await res.text();
    if (!res.ok) throw httpSyncError('Stripe', res.status, text);
    try {
      return JSON.parse(text) as StripeObj;
    } catch {
      throw new BillingSyncError('TRANSIENT', 'Stripe returned a non-JSON body');
    }
  }
}

/** The Stripe price lookup key of a version's price (one per version + interval). */
export function lookupKey(plan_version_id: string, interval: 'MONTH' | 'YEAR'): string {
  return `aramo_${plan_version_id}_${interval.toLowerCase()}`;
}

function usPrice(t: Pick<BillingSyncTarget, 'prices'>): { amount_minor: number } {
  const us = t.prices.find((p) => p.country === 'US');
  if (us === undefined || us.currency !== 'USD') throw new BillingSyncError('PROVIDER_REJECTED', 'the catalog has no US / USD price for Stripe', false);
  return us;
}

const enc = encodeURIComponent;
