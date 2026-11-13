import { razorpayApiBase, razorpayCredentials } from '../razorpay-billing.provider.js';

import {
  BillingSyncError,
  httpSyncError,
  type BillingProductSyncPort,
  type BillingSyncOutcome,
  type BillingSyncTarget,
  type BillingTargetPrice,
  type LiveProviderPrice,
  type PreviewProviderPrice,
  type SyncFetch,
} from './billing-sync.port.js';

// India Billing Regions + Razorpay Directive v1.0 (LOCKED) §4.6, ruling Q8 — the Razorpay catalog writer.
// One Razorpay plan per published version: Razorpay plans are immutable and Razorpay assigns their ids,
// so there is no create-or-adopt by Aramo id (as Stripe's product GET). Instead the writer lists the
// account's plans and ADOPTS the one whose notes carry this version (`aramo_plan_version_id`) on the same
// terms (amount, currency, monthly period); only when none exists does it create one. A retry after a
// lost response therefore never makes a second plan for the same version.
//
// The price is the version's regional IN / INR MONTH price (Q8; MONTH only in v1, §7). A version with no
// IN / INR MONTH price is not sold in India: the writer creates nothing and reports the typed
// BillingNotSellableError (the sync engine settles that job without blocking any other channel).
//
// Dark launch: G-2 (no credentials ⇒ NOT_CONFIGURED) and G-4 (SIGN_RAZORPAY_BILLING_ENABLED must be exactly
// `1`, the flag that also gates the webhook route). Credentials and the API base come ONLY through the Razorpay adapter's exported readers
// (razorpayCredentials / razorpayApiBase; CCP-C5 C5-G-1R pins the readers to that file and this one).
// No tax parameter is sent. The key is never logged.

/** The country and currency a Razorpay plan is sold in (India Billing §1: IN = Razorpay / INR). */
export const RAZORPAY_COUNTRY = 'IN';
export const RAZORPAY_CURRENCY = 'INR';

/** Directive §6 G-4 — the writer is dark unless SIGN_RAZORPAY_BILLING_ENABLED is exactly `1` (as the webhook route). */
export function razorpayBillingEnabled(): boolean {
  return process.env['SIGN_RAZORPAY_BILLING_ENABLED']?.trim() === '1';
}
/** The adopt scan pages through at most this many plans (100 per page). */
const LIST_PAGE = 100;
const LIST_MAX_PAGES = 50;

interface RazorpayPlan {
  id?: string;
  period?: string;
  interval?: number;
  item?: { name?: string; description?: string | null; amount?: number; currency?: string } | null;
  notes?: Record<string, unknown> | unknown[] | null;
}

interface RazorpayCollection {
  items?: RazorpayPlan[];
  count?: number;
}

/** The target version has no IN / INR price for the interval: no Razorpay plan is made (Q8). */
export class BillingNotSellableError extends BillingSyncError {
  readonly reason = 'not_sellable_in_region' as const;
  constructor(readonly country: string, message: string) {
    super('PROVIDER_REJECTED', message, false);
    this.name = 'BillingNotSellableError';
  }
}

/** The version's IN / INR price of the target's interval, or null (not sold in India). */
export function razorpayTargetPrice(t: Pick<BillingSyncTarget, 'prices'>): BillingTargetPrice | null {
  return t.prices.find((p) => p.country === RAZORPAY_COUNTRY && p.currency === RAZORPAY_CURRENCY) ?? null;
}

export class RazorpayCatalogWriter implements BillingProductSyncPort {
  readonly provider = 'RAZORPAY' as const;

  constructor(
    private readonly fetchImpl: SyncFetch = (url, init) => fetch(url, init),
    private readonly transport: { credentials: () => { key_id: string; key_secret: string } | undefined; base: () => string; enabled: () => boolean } = {
      credentials: razorpayCredentials,
      base: razorpayApiBase,
      enabled: razorpayBillingEnabled,
    },
  ) {}

  /** G-2 + G-4 — the Razorpay key id and secret are both set, and SIGN_RAZORPAY_BILLING_ENABLED is exactly `1`. */
  configured(): boolean {
    return this.transport.enabled() && this.transport.credentials() !== undefined;
  }

  async sync(t: BillingSyncTarget): Promise<BillingSyncOutcome> {
    const price = this.priceOf(t);
    const found = await this.findPlan((p) => noteOf(p, 'aramo_plan_version_id') === t.plan_version_id);
    if (found !== null) {
      if (!sameTerms(found, price)) {
        throw new BillingSyncError('PROVIDER_REJECTED', `Razorpay plan ${String(found.id)} exists for this version with different terms; a published version's price is immutable`, false);
      }
      return outcome(found, t.known_external_ref === null ? 'ADOPTED' : 'EXISTING');
    }
    const created = await this.post('/v1/plans', {
      period: 'monthly',
      interval: 1,
      item: {
        name: t.display_name,
        amount: price.amount_minor,
        currency: RAZORPAY_CURRENCY,
        description: t.description,
      },
      notes: {
        aramo_plan_key: t.plan_key,
        aramo_plan_version_id: t.plan_version_id,
        aramo_product_id: t.product_id,
      },
    });
    return outcome(created, 'CREATED');
  }

  /** BP-5 — the IN / INR price the sync would set (Razorpay takes any exact amount); none when not sold in India. */
  async preview(t: BillingSyncTarget): Promise<PreviewProviderPrice[]> {
    const p = razorpayTargetPrice(t);
    if (p === null || t.interval !== 'MONTH') return [];
    return [{ country: RAZORPAY_COUNTRY, currency: RAZORPAY_CURRENCY, amount_minor: p.amount_minor, available: true, nearest: [] }];
  }

  /** A1-2 — India when a Razorpay plan of this Aramo product exists already; null for a product never synced. */
  async liveCountries(t: BillingSyncTarget): Promise<string[] | null> {
    if (!this.configured()) return null;
    const any = await this.findPlan((p) => noteOf(p, 'aramo_product_id') === t.product_id);
    return any === null ? null : [RAZORPAY_COUNTRY];
  }

  /** BP-12 — the India price the version's Razorpay plan charges now (null when it has no plan). */
  async livePrices(t: Pick<BillingSyncTarget, 'provider' | 'interval' | 'product_id' | 'known_external_ref' | 'prices' | 'plan_version_id'>): Promise<LiveProviderPrice[]> {
    const plan = await this.findPlan((p) => noteOf(p, 'aramo_plan_version_id') === t.plan_version_id);
    const amount = plan?.item?.amount;
    return [{ country: RAZORPAY_COUNTRY, currency: RAZORPAY_CURRENCY, amount_minor: typeof amount === 'number' && plan?.item?.currency === RAZORPAY_CURRENCY ? amount : null }];
  }

  // ---- shared ------------------------------------------------------------------------------

  private priceOf(t: BillingSyncTarget): BillingTargetPrice {
    if (t.interval !== 'MONTH') throw new BillingSyncError('PROVIDER_REJECTED', 'Razorpay sells MONTH prices only (India Billing §7)', false);
    const p = razorpayTargetPrice(t);
    if (p === null) throw new BillingNotSellableError(RAZORPAY_COUNTRY, `not sold in India: version ${t.version_number} of ${t.plan_key} has no IN / INR monthly price, so no Razorpay plan is created`);
    if (!Number.isSafeInteger(p.amount_minor) || p.amount_minor <= 0) throw new BillingSyncError('PROVIDER_REJECTED', 'the IN / INR price must be a positive whole number of paise', false);
    return p;
  }

  /** The first plan of the account matching `match` (pages through the plan list; newest first). */
  private async findPlan(match: (p: RazorpayPlan) => boolean): Promise<RazorpayPlan | null> {
    for (let page = 0; page < LIST_MAX_PAGES; page++) {
      const res = (await this.get(`/v1/plans?count=${LIST_PAGE}&skip=${page * LIST_PAGE}`)) as RazorpayCollection;
      const items = Array.isArray(res.items) ? res.items : [];
      const hit = items.find(match);
      if (hit !== undefined) return hit;
      if (items.length < LIST_PAGE) return null;
    }
    // Never guess past the scan bound: creating here could make a second plan for the version.
    throw new BillingSyncError('PROVIDER_REJECTED', `the Razorpay plan list is longer than ${LIST_PAGE * LIST_MAX_PAGES}; the adopt scan cannot prove the version has no plan`, false);
  }

  // ---- transport ---------------------------------------------------------------------------

  private async get(path: string): Promise<Record<string, unknown>> {
    return this.parse(await this.call('GET', path));
  }

  private async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.parse(await this.call('POST', path, JSON.stringify(body)));
  }

  private async call(method: string, path: string, body?: string): Promise<Response> {
    const creds = this.configured() ? this.transport.credentials() : undefined;
    if (creds === undefined) throw new BillingSyncError('NOT_CONFIGURED', 'Razorpay sync is not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET, SIGN_RAZORPAY_BILLING_ENABLED=1)', false);
    const headers: Record<string, string> = { authorization: `Basic ${Buffer.from(`${creds.key_id}:${creds.key_secret}`, 'utf8').toString('base64')}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await this.fetchImpl(`${this.transport.base()}${path}`, { method, headers, body });
    } catch (e) {
      throw new BillingSyncError('TRANSIENT', `Razorpay unreachable: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }

  private async parse(res: Response): Promise<Record<string, unknown>> {
    const text = await res.text();
    if (!res.ok) throw httpSyncError('Razorpay', res.status, text);
    try {
      const v = JSON.parse(text) as unknown;
      return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      throw new BillingSyncError('TRANSIENT', 'Razorpay returned a non-JSON body');
    }
  }
}

function noteOf(p: RazorpayPlan, key: string): string | null {
  const n = p.notes;
  if (typeof n !== 'object' || n === null || Array.isArray(n)) return null;
  const v = n[key];
  return typeof v === 'string' ? v : null;
}

function sameTerms(p: RazorpayPlan, price: BillingTargetPrice): boolean {
  return p.period === 'monthly' && p.interval === 1 && p.item?.amount === price.amount_minor && p.item?.currency === RAZORPAY_CURRENCY;
}

function outcome(p: RazorpayPlan | Record<string, unknown>, origin: BillingSyncOutcome['origin']): BillingSyncOutcome {
  const id = (p as RazorpayPlan).id;
  if (typeof id !== 'string' || id === '') throw new BillingSyncError('TRANSIENT', 'Razorpay returned no plan id');
  // The plan id is the purchase link (PlanVersionPrice.provider_price_ref): checkout sends it as plan_id.
  return { status: 'SYNCED', origin, external_ref: null, external_price_ref: id, store_state: null, detail: null };
}
