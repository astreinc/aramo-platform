// CCP Billing Products Directive v1.0 (LOCKED) §3.2 — the provider sync port. Each provider client
// (Stripe, App Store Connect, Google Play) makes ONE billing product of a plan match the catalog:
// create-or-adopt, then name / description, prices and countries. Idempotent: running it twice with the
// same target changes nothing the second time. Never logs a credential.

import type { BillingInterval, BillingProvider } from './billing-product.js';

/** One price of the target: the US list price (country US) or a regional price (BP-5: exact amounts). */
export interface BillingTargetPrice {
  /** ISO 3166 alpha-2. */
  country: string;
  /** ISO 4217. */
  currency: string;
  amount_minor: number;
}

export interface BillingSyncTarget {
  provider: BillingProvider;
  interval: BillingInterval;
  product_id: string;
  plan_id: string;
  plan_key: string;
  /** The store listing name (the request's `listing.name`; the plan name when the request has none). */
  display_name: string;
  /** The store listing description (the request's `listing.description`; the plan description for Stripe-only). */
  description: string;
  /** A1-2 — countries the request explicitly stops selling in; any other country a store sells in today is kept or the sync refuses. */
  stop_countries: readonly string[];
  plan_version_id: string;
  version_number: number;
  /** US list price first, then one entry per regional price; the countries the product is sold in. */
  prices: readonly BillingTargetPrice[];
  /** The provider's own resource id from a previous sync (BillingProduct.external_ref), if any. */
  known_external_ref: string | null;
  /** BP-7 — the Apple review screenshot, when the request carried one. */
  review_screenshot: { file_name: string; content_type: string; bytes: Uint8Array; sha256: string } | null;
}

export interface BillingSyncOutcome {
  /** SYNCED: the provider matches the catalog. NEEDS_ATTENTION: it does, but the provider asks for a manual step (e.g. Apple review). */
  status: 'SYNCED' | 'NEEDS_ATTENTION';
  origin: 'CREATED' | 'ADOPTED' | 'EXISTING';
  /** The provider's resource id to remember (Apple subscription id); null when product_id is enough. */
  external_ref: string | null;
  /** The provider price the purchase link uses (the Stripe price id); null for a store product. */
  external_price_ref: string | null;
  /** The provider's own state of the product (display only). */
  store_state: string | null;
  detail: string | null;
}

export type BillingSyncErrorCode =
  /** The provider's credentials or ids are not configured (the provider is dark). */
  | 'NOT_CONFIGURED'
  /** The store has no price point for an exact catalog amount (BP-5: never rounded). */
  | 'PRICE_POINT_UNAVAILABLE'
  /** The catalog asks for something the provider refuses (a 4xx other than throttling); needs a person. */
  | 'PROVIDER_REJECTED'
  /** A network error, a 5xx or throttling: retried with backoff. */
  | 'TRANSIENT';

export class BillingSyncError extends Error {
  constructor(
    readonly code: BillingSyncErrorCode,
    message: string,
    readonly retryable: boolean = code === 'TRANSIENT',
  ) {
    super(message);
    this.name = 'BillingSyncError';
  }
}

/** One country's price as the provider charges it now (the mismatch report, BP-12). */
export interface LiveProviderPrice {
  country: string;
  currency: string;
  amount_minor: number | null;
}

/** One country's price the sync WOULD set (the approver's preview, BP-5). */
export interface PreviewProviderPrice {
  country: string;
  currency: string;
  amount_minor: number;
  /** false: the provider has no exact point for it (the draft is refused); `nearest` lists alternatives. */
  available: boolean;
  nearest: number[];
}

export interface BillingProductSyncPort {
  readonly provider: BillingProvider;
  /** False when the provider's credentials are not set (its sync stays dark). */
  configured(): boolean;
  sync(target: BillingSyncTarget): Promise<BillingSyncOutcome>;
  preview(target: BillingSyncTarget): Promise<PreviewProviderPrice[]>;
  /** A1-2 — the countries the product is sold in today (ISO alpha-2), or null when it does not exist yet. */
  liveCountries(target: BillingSyncTarget): Promise<string[] | null>;
  livePrices(target: Pick<BillingSyncTarget, 'provider' | 'interval' | 'product_id' | 'known_external_ref' | 'prices' | 'plan_version_id'>): Promise<LiveProviderPrice[]>;
}

export type SyncFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A non-2xx provider response → the error class the sync engine acts on. */
export function httpSyncError(provider: string, status: number, body: string): BillingSyncError {
  const short = body.replace(/\s+/g, ' ').slice(0, 400);
  if (status === 429 || status >= 500) return new BillingSyncError('TRANSIENT', `${provider} HTTP ${status}: ${short}`);
  if (status === 401 || status === 403) return new BillingSyncError('NOT_CONFIGURED', `${provider} refused the credentials (HTTP ${status}): ${short}`, false);
  return new BillingSyncError('PROVIDER_REJECTED', `${provider} HTTP ${status}: ${short}`, false);
}

/** A1-2 — the countries a sync would stop selling in without the request saying so (empty = safe). */
export function unconfirmedDrops(live: readonly string[] | null, target: Pick<BillingSyncTarget, 'prices' | 'stop_countries'>): string[] {
  if (live === null) return [];
  const want = new Set(target.prices.map((p) => p.country));
  const stop = new Set(target.stop_countries);
  return [...new Set(live)].filter((c) => !want.has(c) && !stop.has(c)).sort();
}

/** The refusal of a sync that would silently narrow a store's countries. */
export function dropRefusal(store: string, drops: readonly string[]): BillingSyncError {
  return new BillingSyncError('PROVIDER_REJECTED', `${store} sells this plan in ${drops.join(', ')} today and this version has no price there: add a regional price for ${drops.length === 1 ? 'it' : 'them'}, or publish a version that confirms the stop`, false);
}
