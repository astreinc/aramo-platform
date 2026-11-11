import type { BillingProductLink, BillingProductsPayload, BillingProductView, BillingProvider, BillingSyncStatus, CatalogVersionDetail } from './catalog-api';

// CCP Billing Products, One Catalog Across Web and Apps, Directive v1.0 (LOCKED) — the console model of a
// publish's billing products: one row per channel the plan may sell on (BP-2), the permanent id locked
// once it exists (BP-3), the plan's current channels carried forward (BP-11), and a channel the plan sells
// on today that the requester unticks becomes an explicit "stop selling" the approver sees. Pure.

export const PROVIDER_LABEL: Record<BillingProvider, string> = {
  STRIPE: 'Web (Stripe)',
  APP_STORE: 'iPhone (App Store)',
  GOOGLE_PLAY: 'Android (Google Play)',
};

export const BILLING_PRODUCTS_INTRO =
  'One billing product per channel, created and priced from this catalog. On approval, Aramo creates or updates the product in Stripe, the App Store and Google Play at exactly this version’s prices; a channel sells the version once its sync succeeds. Nothing is created by hand in the stores.';

export interface BillingEditorRow {
  provider: BillingProvider;
  interval: 'MONTH';
  selected: boolean;
  product_id: string;
  /** The id is permanent (a billing product already exists): not editable. */
  locked: boolean;
  /** The plan sells on this channel today. */
  sold: boolean;
}

const STORE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,149}$/;
const STRIPE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/** BP-3 default id (mirrors libs/subscription billing-product.ts). */
export function defaultProductId(provider: BillingProvider, plan_key: string): string {
  const core = plan_key.replace(/^aramo-sign-/, '').replace(/-v\d+$/, '');
  const parts = core.split('-').filter((x) => x !== '');
  const kindAt = parts.findIndex((x) => x === 'personal' || x === 'business' || x === 'professional');
  if (kindAt > 0) parts.unshift(...parts.splice(kindAt, 1));
  const slug = parts.join('_').replace(/[^a-z0-9_]/g, '');
  return provider === 'STRIPE' ? `aramo_sign_${slug}` : `ai.aramo.sign.${slug}.monthly`;
}

/** The editor's starting rows for a publish of `detail`'s version. */
export function initialBillingRows(detail: Pick<CatalogVersionDetail, 'billing_eligible' | 'billing_carry_forward' | 'billing_products'>, plan_key: string): BillingEditorRow[] {
  return detail.billing_eligible.map((provider) => {
    const permanent = detail.billing_products.find((b) => b.provider === provider && b.interval === 'MONTH' && b.origin !== null);
    const carried = detail.billing_carry_forward.find((c) => c.provider === provider && c.interval === 'MONTH');
    return {
      provider,
      interval: 'MONTH' as const,
      selected: true,
      product_id: permanent?.product_id ?? carried?.product_id ?? defaultProductId(provider, plan_key),
      locked: permanent !== undefined,
      sold: carried !== undefined,
    };
  });
}

/** True when a selected App Store row has no permanent product yet (it will be created: BP-7 needs a screenshot). */
export function needsReviewScreenshot(rows: BillingEditorRow[]): boolean {
  return rows.some((r) => r.provider === 'APP_STORE' && r.selected && !r.locked);
}

/** Apple's in-app purchase localization limits (mirrors libs/subscription STORE_LISTING_LIMITS). */
export const STORE_LISTING_LIMITS = { name_min: 2, name_max: 30, description_min: 1, description_max: 45 } as const;

export interface StoreListingInput {
  name: string;
  description: string;
}

/** True when a selected row is a store (App Store / Google Play): the request then needs the store listing. */
export function sellsInStores(rows: BillingEditorRow[]): boolean {
  return rows.some((r) => r.selected && r.provider !== 'STRIPE');
}

/** The store listing's errors (empty = valid, or no store selected). */
export function listingErrors(rows: BillingEditorRow[], listing: StoreListingInput): string[] {
  if (!sellsInStores(rows)) return [];
  const L = STORE_LISTING_LIMITS;
  const name = listing.name.trim();
  const desc = listing.description.trim();
  const out: string[] = [];
  if (name.length < L.name_min || name.length > L.name_max) out.push(`Store name: ${L.name_min} to ${L.name_max} characters (now ${name.length}).`);
  if (desc.length < L.description_min || desc.length > L.description_max) out.push(`Store description: ${L.description_min} to ${L.description_max} characters (now ${desc.length}).`);
  const text = listing.name + listing.description;
  if (/[<>]/.test(text) || [...text].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) out.push('Store name and description: plain text on one line.');
  return out;
}

/**
 * The countries each store channel sells the version in: the US list price plus every monthly regional
 * price (the stores sell exactly where the catalog has a price). Stripe sells on the web at the US price.
 */
export function sellsInCountries(regional: readonly { country: string; interval: 'MONTH' | 'YEAR' }[] | undefined): string[] {
  return ['US', ...[...new Set((regional ?? []).filter((r) => r.interval === 'MONTH').map((r) => r.country))].filter((c) => c !== 'US').sort()];
}

export function billingEditorErrors(rows: BillingEditorRow[], screenshotId: string | null, listing?: StoreListingInput, unconfirmedStops: readonly string[] = []): string[] {
  const errors: string[] = listing === undefined ? [] : listingErrors(rows, listing);
  if (unconfirmedStops.length > 0) errors.push(`The stores sell this plan in ${unconfirmedStops.join(', ')} today: add a regional price there, or confirm the stop.`);
  for (const r of rows) {
    if (!r.selected) continue;
    const ok = r.provider === 'STRIPE' ? STRIPE_ID.test(r.product_id) : STORE_ID.test(r.product_id);
    if (!ok) errors.push(`${PROVIDER_LABEL[r.provider]}: the product id ${r.product_id === '' ? 'is empty' : 'has characters the store does not accept'}`);
  }
  if (needsReviewScreenshot(rows) && screenshotId === null) errors.push('A new App Store product needs the review screenshot of the in-app Plans screen.');
  return errors;
}

export function billingPayload(rows: BillingEditorRow[], screenshotId: string | null, listing?: StoreListingInput, stopCountries: readonly string[] = []): BillingProductsPayload {
  const products: BillingProductLink[] = rows.filter((r) => r.selected).map((r) => ({ provider: r.provider, interval: r.interval, product_id: r.product_id.trim() }));
  const stop = rows.filter((r) => r.sold && !r.selected).map((r) => r.provider);
  return {
    products,
    ...(stop.length > 0 ? { stop_selling: stop } : {}),
    ...(screenshotId !== null && needsReviewScreenshot(rows) ? { apple_review_screenshot_asset_id: screenshotId } : {}),
    ...(listing !== undefined && sellsInStores(rows) ? { listing: { name: listing.name.trim(), description: listing.description.trim() } } : {}),
    ...(stopCountries.length > 0 ? { stop_countries: [...new Set(stopCountries)].sort() } : {}),
  };
}

const STATUS_LABEL: Record<BillingSyncStatus, string> = {
  PENDING: 'Syncing',
  SYNCED: 'In sync',
  NEEDS_ATTENTION: 'Needs attention',
  FAILED: 'Retrying',
  NOT_CONFIGURED: 'Not connected',
};

/** The one-line status of a channel on this version. */
export function billingStatusText(v: BillingProductView): { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted'; detail: string | null } {
  if (v.sync === null) return v.linked ? { label: 'Selling', tone: 'ok', detail: null } : { label: 'Not on this version', tone: 'muted', detail: null };
  const tone = v.sync.status === 'SYNCED' ? 'ok' : v.sync.status === 'NEEDS_ATTENTION' ? 'bad' : v.sync.status === 'NOT_CONFIGURED' ? 'muted' : 'warn';
  const store = v.sync.store_state !== null ? ` · store state ${v.sync.store_state}` : '';
  return { label: `${STATUS_LABEL[v.sync.status]}${store}`, tone, detail: v.sync.last_error };
}

/** A retry is offered for a sync that did not succeed (owner only). */
export function canRetry(v: BillingProductView): boolean {
  return v.sync !== null && (v.sync.status === 'NEEDS_ATTENTION' || v.sync.status === 'FAILED' || v.sync.status === 'NOT_CONFIGURED');
}

/** "10.00 USD" from minor units (two-decimal currencies; zero-decimal shown whole). */
export function formatMinor(amount_minor: number, currency: string): string {
  const zero = ['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'PYG', 'UGX'].includes(currency);
  return zero ? `${amount_minor} ${currency}` : `${(amount_minor / 100).toFixed(2)} ${currency}`;
}
