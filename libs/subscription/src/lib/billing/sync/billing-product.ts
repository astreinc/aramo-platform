// CCP Billing Products, One Catalog Across Web and Apps, Directive v1.0 (LOCKED, sha256 3d2b67c1) —
// the pure billing-product model: the PLAN_VERSION_PUBLISH `billing_products` payload, its shape check,
// channel eligibility (BP-2), the permanent-id rules (BP-3) and the carry-forward check (BP-11).
// No I/O here; the change-request service and the sync engine call these.

// India Billing Regions + Razorpay Directive v1.0 (LOCKED) §4.2 — RAZORPAY (web, India) joins the set.
export type BillingProvider = 'STRIPE' | 'APP_STORE' | 'GOOGLE_PLAY' | 'RAZORPAY';
export type BillingInterval = 'MONTH' | 'YEAR';

export const BILLING_PROVIDERS: readonly BillingProvider[] = ['STRIPE', 'APP_STORE', 'GOOGLE_PLAY', 'RAZORPAY'];

/** The payload key a PLAN_VERSION_PUBLISH carries (closed shape, checksummed with the request). */
export const BILLING_PRODUCTS_KEY = 'billing_products';

export interface BillingProductLink {
  provider: BillingProvider;
  interval: BillingInterval;
  product_id: string;
}

export interface BillingProductsPayload {
  products: BillingProductLink[];
  /** BP-11 — channels the plan was sold on that this version explicitly stops selling on. */
  stop_selling?: BillingProvider[];
  /** BP-7 — the Apple review screenshot (a BillingAsset id) sent with the App Store product. */
  apple_review_screenshot_asset_id?: string;
  /**
   * PO 2026-11-11 (A1-1) — the shopper-facing store listing of this version: the name and description
   * the App Store and Google Play show. Separate from the internal plan description. Required when the
   * version sells on a store; limits are Apple's (the stricter store), see STORE_LISTING_LIMITS.
   */
  listing?: StoreListing;
  /**
   * PO 2026-11-11 (A1-2) — countries a store sells this plan in today that this version explicitly stops
   * selling in. Without it the sync refuses to narrow a store's countries (never a silent drop).
   */
  stop_countries?: string[];
}

export interface StoreListing {
  name: string;
  description: string;
}

/** Apple's in-app purchase localization limits (name 2..30, description ≤ 45); Google Play allows more. */
export const STORE_LISTING_LIMITS = { name_min: 2, name_max: 30, description_min: 1, description_max: 45 } as const;

/** True when the text has a control character (U+0000..U+001F, U+007F), a newline included. */
const hasControl = (t: string): boolean => [...t].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

/** Errors of a store listing (empty = valid): lengths and no control characters or markup. */
export function storeListingErrors(l: StoreListing): string[] {
  const L = STORE_LISTING_LIMITS;
  const out: string[] = [];
  const name = l.name.trim();
  const desc = l.description.trim();
  if (name.length < L.name_min || name.length > L.name_max) out.push(`the store name must be ${L.name_min} to ${L.name_max} characters (it is ${name.length})`);
  if (desc.length < L.description_min || desc.length > L.description_max) out.push(`the store description must be ${L.description_min} to ${L.description_max} characters (it is ${desc.length})`);
  if (hasControl(l.name) || hasControl(l.description) || /[<>]/.test(l.name + l.description)) out.push('the store name and description must be plain text on one line');
  return out;
}

/** A store or Stripe product id: 1..150 chars, starting alphanumeric (the existing STORE_PRODUCT_ID rule). */
export const BILLING_PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,149}$/;
/** Stripe accepts custom product ids of letters, digits, `_` and `-`. */
export const STRIPE_PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Shape errors of a `billing_products` value (empty = valid). */
export function billingProductsShapeErrors(v: unknown): string[] {
  const w = BILLING_PRODUCTS_KEY;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return [`${w} must be an object`];
  const o = v as Record<string, unknown>;
  const errors: string[] = [];
  for (const k of Object.keys(o)) if (!['products', 'stop_selling', 'apple_review_screenshot_asset_id', 'listing', 'stop_countries'].includes(k)) errors.push(`${w}.${k} is not allowed`);
  const products = o['products'];
  if (!Array.isArray(products) || products.length > 6) {
    errors.push(`${w}.products must be an array of at most 6 billing products`);
  } else {
    const seen = new Set<string>();
    products.forEach((e, i) => {
      const p = `${w}.products[${i}]`;
      if (typeof e !== 'object' || e === null || Array.isArray(e)) {
        errors.push(`${p} must be an object`);
        return;
      }
      const x = e as Record<string, unknown>;
      for (const k of Object.keys(x)) if (!['provider', 'interval', 'product_id'].includes(k)) errors.push(`${p}.${k} is not allowed`);
      if (!(BILLING_PROVIDERS as readonly unknown[]).includes(x['provider'])) errors.push(`${p}.provider must be STRIPE, APP_STORE, GOOGLE_PLAY or RAZORPAY`);
      if (x['interval'] !== 'MONTH' && x['interval'] !== 'YEAR') errors.push(`${p}.interval must be MONTH or YEAR`);
      if (x['provider'] === 'STRIPE' && x['interval'] !== 'MONTH') errors.push(`${p}: a Stripe product is MONTH`);
      const id = x['product_id'];
      const idOk = typeof id === 'string' && (x['provider'] === 'STRIPE' ? STRIPE_PRODUCT_ID.test(id) : BILLING_PRODUCT_ID.test(id));
      if (!idOk) errors.push(`${p}.product_id must be a ${x['provider'] === 'STRIPE' ? 'Stripe' : 'store'} product id`);
      const key = `${String(x['provider'])}:${String(x['interval'])}`;
      if (seen.has(key)) errors.push(`${p} repeats a provider and interval`);
      seen.add(key);
    });
  }
  const stop = o['stop_selling'];
  if (stop !== undefined) {
    if (!Array.isArray(stop) || stop.some((s) => !(BILLING_PROVIDERS as readonly unknown[]).includes(s)) || new Set(stop).size !== stop.length) {
      errors.push(`${w}.stop_selling must be a list of distinct providers`);
    } else if (Array.isArray(products)) {
      for (const s of stop) if (products.some((e) => (e as Record<string, unknown> | null)?.['provider'] === s)) errors.push(`${w}.stop_selling names ${String(s)}, which the version also sells on`);
    }
  }
  const listing = o['listing'];
  if (listing !== undefined) {
    const l = listing as Record<string, unknown> | null;
    if (typeof l !== 'object' || l === null || Array.isArray(l) || Object.keys(l).some((k) => k !== 'name' && k !== 'description') || typeof l['name'] !== 'string' || typeof l['description'] !== 'string') {
      errors.push(`${w}.listing must be { name, description }`);
    } else {
      for (const m of storeListingErrors({ name: l['name'], description: l['description'] })) errors.push(`${w}.listing: ${m}`);
    }
  }
  const stopCountries = o['stop_countries'];
  if (stopCountries !== undefined) {
    if (!Array.isArray(stopCountries) || stopCountries.length > 250 || stopCountries.some((c) => typeof c !== 'string' || !/^[A-Z]{2}$/.test(c) || c === 'US') || new Set(stopCountries).size !== stopCountries.length) {
      errors.push(`${w}.stop_countries must be distinct two-letter country codes other than US`);
    }
  }
  const shot = o['apple_review_screenshot_asset_id'];
  if (shot !== undefined && !(typeof shot === 'string' && UUID.test(shot))) errors.push(`${w}.apple_review_screenshot_asset_id must be a uuid`);
  return errors;
}

/** The plan facts eligibility is decided on (the live Plan row). */
export interface BillingPlanFacts {
  tenant_kind: string | null;
  sales_model: string | null;
}

/**
 * BP-2 (PO 2026-11-11) — the channels a plan may have a billing product on. PERSONAL self-service:
 * web (Stripe), App Store and Google Play. BUSINESS self-service: web (Stripe) only (the tenant admin
 * manages it on the web; the apps never sell a Business plan). Every other plan: none (sales-led).
 */
export function eligibleProviders(plan: BillingPlanFacts): readonly BillingProvider[] {
  if (plan.sales_model !== 'SELF_SERVICE') return [];
  // Unchanged by WS-A (the RAZORPAY eligibility is the India Billing catalog workstream's): the three channels.
  if (plan.tenant_kind === 'PERSONAL') return ['STRIPE', 'APP_STORE', 'GOOGLE_PLAY'];
  if (plan.tenant_kind === 'BUSINESS') return ['STRIPE'];
  return [];
}

/** BP-3 — the default product id: `ai.aramo.sign.<plan_slug>.<interval>` (stores), `aramo_sign_<plan_slug>` (Stripe). */
export function defaultProductId(provider: BillingProvider, plan_key: string, interval: BillingInterval): string {
  const slug = planSlug(plan_key);
  if (provider === 'STRIPE') return `aramo_sign_${slug}`;
  return `ai.aramo.sign.${slug}.${interval === 'MONTH' ? 'monthly' : 'yearly'}`;
}

/**
 * `aramo-sign-standard-personal-v1` → `personal_standard` (the product word order the first App Store
 * product used: tenant kind first). Plans without a kind word keep their own order.
 */
export function planSlug(plan_key: string): string {
  const core = plan_key.replace(/^aramo-sign-/, '').replace(/-v\d+$/, '');
  const parts = core.split('-').filter((x) => x !== '');
  const kindAt = parts.findIndex((x) => x === 'personal' || x === 'business' || x === 'professional');
  if (kindAt > 0) parts.unshift(...parts.splice(kindAt, 1));
  return parts.join('_').replace(/[^a-z0-9_]/g, '');
}

/** An existing permanent billing product of the plan (BillingProduct row). */
export interface ExistingBillingProduct {
  provider: BillingProvider;
  interval: BillingInterval;
  product_id: string;
}

/** A channel the plan's current PUBLISHED version sells on (a purchase link exists). */
export interface SoldChannel {
  provider: BillingProvider;
  interval: BillingInterval;
}

export interface BillingProductsRuleError {
  code: 'PROVIDER_NOT_ELIGIBLE' | 'PRODUCT_ID_PERMANENT' | 'PRODUCT_ID_TAKEN' | 'CHANNEL_DROPPED' | 'SCREENSHOT_REQUIRED' | 'PRICE_NOT_AVAILABLE' | 'LISTING_REQUIRED' | 'COUNTRY_NOT_SOLD' | 'STOP_COUNTRY_PRICED';
  message: string;
}

/**
 * The publish-time rules over a valid `billing_products` payload:
 *  - BP-2 every product's provider is eligible for the plan;
 *  - BP-3 a (provider, interval) that already has a permanent product keeps that exact id, and an id
 *    already used by ANOTHER plan or interval is refused;
 *  - BP-11 a channel the current version sells on is either carried forward or explicitly stopped;
 *  - BP-7 an App Store product that does not exist yet needs the review screenshot.
 */
export function billingProductsRuleErrors(input: {
  payload: BillingProductsPayload;
  plan: BillingPlanFacts;
  existing: readonly ExistingBillingProduct[];
  /** Permanent products of OTHER plans with the same provider + id (id collisions). */
  taken_elsewhere: readonly ExistingBillingProduct[];
  sold: readonly SoldChannel[];
}): BillingProductsRuleError[] {
  const errors: BillingProductsRuleError[] = [];
  const eligible = eligibleProviders(input.plan);
  for (const p of input.payload.products) {
    if (!eligible.includes(p.provider)) {
      errors.push({ code: 'PROVIDER_NOT_ELIGIBLE', message: `${p.provider} is not a channel for this plan (eligible: ${eligible.join(', ') || 'none'})` });
    }
    const mine = input.existing.find((e) => e.provider === p.provider && e.interval === p.interval);
    if (mine !== undefined && mine.product_id !== p.product_id) {
      errors.push({ code: 'PRODUCT_ID_PERMANENT', message: `${p.provider} ${p.interval} is permanently ${mine.product_id}; it cannot become ${p.product_id}` });
    }
    const sameIdOtherSlot = input.existing.find((e) => e.provider === p.provider && e.product_id === p.product_id && e.interval !== p.interval);
    if (sameIdOtherSlot !== undefined || input.taken_elsewhere.some((t) => t.provider === p.provider && t.product_id === p.product_id)) {
      errors.push({ code: 'PRODUCT_ID_TAKEN', message: `${p.provider} product ${p.product_id} already belongs to another plan or interval` });
    }
  }
  const stop = new Set(input.payload.stop_selling ?? []);
  for (const s of input.sold) {
    const carried = input.payload.products.some((p) => p.provider === s.provider && p.interval === s.interval);
    if (!carried && !stop.has(s.provider)) {
      errors.push({ code: 'CHANNEL_DROPPED', message: `the plan sells on ${s.provider} (${s.interval}); carry it forward or choose to stop selling on ${s.provider}` });
    }
  }
  if (input.payload.listing === undefined && input.payload.products.some((p) => p.provider !== 'STRIPE')) {
    errors.push({ code: 'LISTING_REQUIRED', message: 'a store product needs the store name and description (what the App Store and Google Play show)' });
  }
  const newApple = input.payload.products.some((p) => p.provider === 'APP_STORE' && !input.existing.some((e) => e.provider === 'APP_STORE' && e.interval === p.interval));
  if (newApple && input.payload.apple_review_screenshot_asset_id === undefined) {
    errors.push({ code: 'SCREENSHOT_REQUIRED', message: 'a new App Store product needs the review screenshot (upload it in the console)' });
  }
  return errors;
}
