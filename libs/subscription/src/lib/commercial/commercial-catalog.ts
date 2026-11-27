import {
  ANNUAL_COMMIT_MONTHS,
  billingTermsRefusal,
  hasExplicitTerms,
  MAX_REGIONAL_PRICE_MINOR,
  MAX_TERM_PRICE_MINOR,
  MAX_UNIT_PRICE_MINOR,
  type PlanPriceUnit,
  type PlanVersionBillingTerm,
  type PlanVersionContent,
  PlanVersionContentError,
  type PlanVersionRegionalPriceTerm,
  parsePlanVersionContent,
  priceUnitOf,
  seatPriceUnitRefusal,
  versionTerms,
  withBillingTerms,
  withPriceUnit,
  withRegionalPrices,
  withUnitPrices,
} from '../plan-version.js';
import { isMeteredUnitKey } from '../usage/metered-units.js';
import { FEATURE_AVAILABILITY } from '../feature-availability.js';
import { ProductContextError, productOfMeteredKey } from '../product-registry.js';

// CCP-B2 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.3 row B2; MP-A2 N-15, N-16) — the
// pure catalog model behind the platform console's Catalog screen.
//
//   terms        the four editor terms the console shows for a version (handoff §5.4), read
//                from the format-1 content: price = plan.list_price_minor; envelopes per month =
//                the MONTHLY `sign.envelopes` allowance (null = unlimited); storage = the
//                `sign.storage_bytes` capacity. The v1 locks (currency USD, billing interval
//                MONTH) are read, never edited.
//   draft edits  the ONLY content changes the console can make, and only on a DRAFT: price,
//                envelopes per month, storage. An edit can never add an allowance, capacity or
//                feature key, change the plan's identity (key, product, name) or the v1 locks
//                (no invented terms; PBD §7.1). Seats have no key in the Sign plan model, so
//                they are not editable (R-13).
//   unit prices  Sign Feature Parity Amendment A4 (D2) with A3 (D1): the add-on (metered) unit
//                prices of a DRAFT are edited here too, as part of the version's content, so the
//                content fingerprint covers them and they publish only through the existing
//                PLAN_VERSION_PUBLISH chain (Finance → Owner). A unit of the plan's product only;
//                null removes the price (the unit is not sold on that version).
//   regional     Aramo Sign Mobile M-A12 Amendment A1-3 — the regional list prices (e.g. IN / INR,
//   prices       monthly and annual) of a DRAFT, edited the same way: part of the version content,
//                covered by its fingerprint, published only through PLAN_VERSION_PUBLISH (Finance →
//                Owner) and immutable once published. An entry is keyed by (country, interval);
//                amount_minor null removes it. US is never a regional price (the list price is US/USD).
//   price unit   Sign Business per-seat pricing (directive v1.0 §3.4) — a DRAFT of a BUSINESS self-service
//                plan with a list price may be priced per seat ("SEAT") or per account ("ACCOUNT", the key
//                omitted). Part of the content, published only through PLAN_VERSION_PUBLISH. Refused with
//                `price_unit_not_applicable` on any other plan.
//   billing      Sign Monthly and Annual-Commitment Pricing v1.0 §3.1 — the optional ANNUAL_COMMIT price of a
//   terms        DRAFT of a self-service plan (12-month commitment, billed monthly at its own price, web only).
//                Setting it gives the draft explicit terms: MONTHLY = the list price (no commitment, so the
//                plan commitment is cleared), ANNUAL_COMMIT = the given price. null removes the annual term
//                (the draft keeps a MONTHLY-only term). A list-price edit moves the MONTHLY term with it.
//   free parity  SIGN-FREE-PARITY-1 S1 / S5 (LOCKED 2026-11-27; typed divergences D-1, D-6) — a DRAFT may
//                also: edit or REMOVE an existing short-window cap (DAY), REMOVE an allowance the version
//                carries (never add one), edit the plan description, and set a feature's entitlement
//                (on / off). A feature key must be registered in feature-availability.ts for the plan's
//                product — an entitlement, kept apart from launch availability, so a key not yet
//                launched may be entitled ahead of launch (it is never advertised until AVAILABLE).

/** The Sign envelope allowance the editor's "Envelopes per month" reads and edits. */
export const CATALOG_ENVELOPE_ALLOWANCE_KEY = 'sign.envelopes';
/** The Sign storage capacity the editor's "Storage (GB)" reads and edits (binary bytes). */
export const CATALOG_STORAGE_CAPACITY_KEY = 'sign.storage_bytes';
/** v1 release limitation: only monthly USD versions (the schema supports more). */
export const CATALOG_V1_CURRENCY = 'USD';
export const CATALOG_V1_BILLING_INTERVAL = 'MONTH';

export type CatalogConflictReason = 'not_draft' | 'draft_exists' | 'stale' | 'plan_mismatch' | 'contract_priced' | 'term_missing' | 'price_unit_not_applicable';

export class CatalogDraftEditError extends Error {
  constructor(
    readonly reason: CatalogConflictReason,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'CatalogDraftEditError';
  }
}

export interface CatalogVersionTerms {
  /** Minor units (USD cents); null when contract-priced. */
  readonly list_price_minor: number | null;
  readonly currency: string | null;
  readonly billing_interval: string | null;
  readonly sales_model: string;
  /** True when the price is set by contract (no list price, or a contact-sales plan). */
  readonly contract_priced: boolean;
  /** Absent allowance → null with `envelopes_present: false`; unlimited → null. */
  readonly envelopes_per_month: number | null;
  readonly envelopes_unlimited: boolean;
  readonly envelopes_present: boolean;
  /** Binary bytes; null when unlimited or absent. */
  readonly storage_bytes: number | null;
  readonly storage_unlimited: boolean;
  readonly storage_present: boolean;
  /** A3 D1 / A4 D2 — the add-on unit prices on the version (sorted by unit_key; empty = none sold). */
  readonly unit_prices: readonly { readonly unit_key: string; readonly unit_price_minor: number }[];
  /** M-A12 A1-3 — the regional list prices on the version (sorted by country, interval; empty = none). */
  readonly regional_prices: readonly PlanVersionRegionalPriceTerm[];
  /** Per-seat pricing — ACCOUNT when the content carries no price_unit. */
  readonly price_unit: PlanPriceUnit;
  /** The plan's tenant kind (BUSINESS | PERSONAL | null): the console offers per-seat only for BUSINESS. */
  readonly tenant_kind: string | null;
  /** Billing terms — every term the version sells (MONTHLY first; a version without explicit terms: its one derived term). */
  readonly billing_terms: readonly PlanVersionBillingTerm[];
  /** Billing terms — true when the version carries explicit terms (authored with the two-term model). */
  readonly explicit_terms: boolean;
  /** SIGN-FREE-PARITY-1 S1 — the DAY cap on envelopes; null when the version has none. */
  readonly envelopes_per_day: number | null;
  /** SIGN-FREE-PARITY-1 S1 — every allowance key the version carries (sorted). */
  readonly allowance_keys: readonly string[];
  /** SIGN-FREE-PARITY-1 S1 — the plan description carried in the version content. */
  readonly description: string | null;
  /** SIGN-FREE-PARITY-1 S5 — the feature entitlements of the version (sorted by key). */
  readonly features: readonly { readonly feature_key: string; readonly enabled: boolean }[];
}

/** M-A12 A1-3 — one regional-price edit: set (amount_minor) or remove (null) the (country, interval) entry. */
export interface CatalogRegionalPriceEdit {
  readonly country: string;
  readonly interval: 'MONTH' | 'YEAR';
  readonly currency: string;
  readonly amount_minor: number | null;
}

export interface CatalogDraftEdits {
  /** Minor units; a non-negative integer. Refused on a contract-priced plan. */
  readonly list_price_minor?: number;
  /** A non-negative integer, or null for unlimited. */
  readonly envelopes_per_month?: number | null;
  /** Binary bytes; a non-negative integer, or null for unlimited. */
  readonly storage_bytes?: number | null;
  /**
   * A4 D2 — add-on unit prices to set (minor units, 0..MAX_UNIT_PRICE_MINOR) or remove (null =
   * not sold), keyed by metered unit key. Units not named keep their price.
   */
  readonly unit_prices?: Readonly<Record<string, number | null>>;
  /** M-A12 A1-3 — regional prices to set or remove; entries not named keep their price. */
  readonly regional_prices?: readonly CatalogRegionalPriceEdit[];
  /** Per-seat pricing — SEAT (a BUSINESS self-service plan with a list price only) or ACCOUNT. */
  readonly price_unit?: PlanPriceUnit;
  /** Billing terms — the ANNUAL_COMMIT monthly price (minor units, 1..MAX_TERM_PRICE_MINOR), or null to remove it. */
  readonly annual_commit_price_minor?: number | null;
  /** SIGN-FREE-PARITY-1 S1 — the DAY cap on envelopes: a positive integer edits the existing cap; null removes it. */
  readonly envelopes_per_day?: number | null;
  /** SIGN-FREE-PARITY-1 S1 — allowance keys to remove from the version (each must be carried; envelopes never). */
  readonly remove_allowances?: readonly string[];
  /** SIGN-FREE-PARITY-1 S1 — the plan description (1..300 characters), or null to clear it. */
  readonly description?: string | null;
  /** SIGN-FREE-PARITY-1 S5 — feature entitlements to set, keyed by registered feature key. */
  readonly features?: Readonly<Record<string, boolean>>;
}

/** SIGN-FREE-PARITY-1 S1 — the short-window kind the editor's "Envelopes per day" reads and edits. */
export const CATALOG_DAY_WINDOW_KIND = 'DAY';
export const MAX_CATALOG_DESCRIPTION_LENGTH = 300;

export function isContractPriced(content: PlanVersionContent): boolean {
  return content.plan.list_price_minor === null || content.plan.sales_model === 'CONTACT_SALES';
}

function monthlyEnvelopes(content: PlanVersionContent) {
  return content.allowances.find((a) => a.allowance_key === CATALOG_ENVELOPE_ALLOWANCE_KEY && a.period === 'MONTHLY');
}

function storage(content: PlanVersionContent) {
  return content.capacities.find((c) => c.capacity_key === CATALOG_STORAGE_CAPACITY_KEY);
}

export function catalogTermsOf(content: PlanVersionContent): CatalogVersionTerms {
  const env = monthlyEnvelopes(content);
  const sto = storage(content);
  return {
    list_price_minor: content.plan.list_price_minor,
    currency: content.plan.currency,
    billing_interval: content.plan.billing_interval,
    sales_model: content.plan.sales_model,
    contract_priced: isContractPriced(content),
    envelopes_per_month: env === undefined || env.unlimited ? null : env.included_quantity,
    envelopes_unlimited: env?.unlimited ?? false,
    envelopes_present: env !== undefined,
    storage_bytes: sto === undefined || sto.unlimited ? null : sto.limit_quantity,
    storage_unlimited: sto?.unlimited ?? false,
    storage_present: sto !== undefined,
    unit_prices: (content.unit_prices ?? []).map((u) => ({ unit_key: u.unit_key, unit_price_minor: u.unit_price_minor })),
    regional_prices: (content.regional_prices ?? []).map((r) => ({ country: r.country, currency: r.currency, amount_minor: r.amount_minor, interval: r.interval })),
    price_unit: priceUnitOf(content),
    tenant_kind: content.plan.tenant_kind,
    billing_terms: versionTerms(content).map((t) => ({ term: t.term, list_price_minor: t.list_price_minor, commitment_months: t.commitment_months })),
    explicit_terms: hasExplicitTerms(content),
    envelopes_per_day: dayWindow(content)?.limit_quantity ?? null,
    allowance_keys: [...new Set(content.allowances.map((a) => a.allowance_key))].sort(),
    description: content.plan.description,
    features: [...content.features].sort((a, b) => a.feature_key.localeCompare(b.feature_key)).map((f) => ({ feature_key: f.feature_key, enabled: f.enabled })),
  };
}

function featureProduct(key: string): string | null {
  try {
    return productOfMeteredKey(key);
  } catch (e) {
    if (e instanceof ProductContextError) return null;
    throw e;
  }
}

function dayWindow(content: PlanVersionContent) {
  return content.allowance_windows.find((w) => w.allowance_key === CATALOG_ENVELOPE_ALLOWANCE_KEY && w.window_kind === CATALOG_DAY_WINDOW_KIND);
}

const nonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * The DRAFT content after the console's edits. Fails closed: an edit of a term the version does
 * not carry, or a price on a contract-priced plan, throws CatalogDraftEditError. The result is
 * re-parsed strictly (format 1), so it can only be a valid content document.
 */
export function applyCatalogDraftEdits(content: PlanVersionContent, edits: CatalogDraftEdits): PlanVersionContent {
  let plan = content.plan;
  let allowances = content.allowances;
  let capacities = content.capacities;
  if (edits.list_price_minor !== undefined) {
    if (!nonNegInt(edits.list_price_minor)) throw new CatalogDraftEditError('term_missing', 'list_price_minor must be a non-negative integer');
    if (isContractPriced(content)) throw new CatalogDraftEditError('contract_priced', 'this plan is contract-priced: its price is set by contract, not in the catalog');
    plan = { ...plan, list_price_minor: edits.list_price_minor };
  }
  // Billing terms — the MONTHLY term follows the list price (an explicit-terms draft).
  const terms =
    content.terms === undefined || plan.list_price_minor === null
      ? content.terms
      : content.terms.map((t) => (t.term === 'MONTHLY' ? { ...t, list_price_minor: plan.list_price_minor as number } : t));
  if (edits.envelopes_per_month !== undefined) {
    const v = edits.envelopes_per_month;
    if (v !== null && !nonNegInt(v)) throw new CatalogDraftEditError('term_missing', 'envelopes_per_month must be a non-negative integer or null');
    if (monthlyEnvelopes(content) === undefined) throw new CatalogDraftEditError('term_missing', `this version carries no monthly ${CATALOG_ENVELOPE_ALLOWANCE_KEY} allowance`, { term: CATALOG_ENVELOPE_ALLOWANCE_KEY });
    allowances = allowances.map((a) =>
      a.allowance_key === CATALOG_ENVELOPE_ALLOWANCE_KEY && a.period === 'MONTHLY' ? { ...a, included_quantity: v, unlimited: v === null } : a,
    );
  }
  if (edits.storage_bytes !== undefined) {
    const v = edits.storage_bytes;
    if (v !== null && !nonNegInt(v)) throw new CatalogDraftEditError('term_missing', 'storage_bytes must be a non-negative integer or null');
    if (storage(content) === undefined) throw new CatalogDraftEditError('term_missing', `this version carries no ${CATALOG_STORAGE_CAPACITY_KEY} capacity`, { term: CATALOG_STORAGE_CAPACITY_KEY });
    capacities = capacities.map((c) => (c.capacity_key === CATALOG_STORAGE_CAPACITY_KEY ? { ...c, limit_quantity: v, unlimited: v === null } : c));
  }
  // SIGN-FREE-PARITY-1 S1 / S5 — window, allowance removal, description and feature entitlements.
  let allowance_windows = content.allowance_windows;
  let features = content.features;
  if (edits.envelopes_per_day !== undefined) {
    const v = edits.envelopes_per_day;
    if (v !== null && (!nonNegInt(v) || v < 1)) throw new CatalogDraftEditError('term_missing', 'envelopes_per_day must be a positive integer or null');
    if (dayWindow(content) === undefined) {
      throw new CatalogDraftEditError('term_missing', `this version carries no ${CATALOG_DAY_WINDOW_KIND} cap on ${CATALOG_ENVELOPE_ALLOWANCE_KEY}`, { term: `${CATALOG_ENVELOPE_ALLOWANCE_KEY}:${CATALOG_DAY_WINDOW_KIND}` });
    }
    allowance_windows =
      v === null
        ? allowance_windows.filter((w) => !(w.allowance_key === CATALOG_ENVELOPE_ALLOWANCE_KEY && w.window_kind === CATALOG_DAY_WINDOW_KIND))
        : allowance_windows.map((w) => (w.allowance_key === CATALOG_ENVELOPE_ALLOWANCE_KEY && w.window_kind === CATALOG_DAY_WINDOW_KIND ? { ...w, limit_quantity: v } : w));
  }
  if (edits.remove_allowances !== undefined) {
    if (!Array.isArray(edits.remove_allowances) || !edits.remove_allowances.every((k) => typeof k === 'string')) {
      throw new CatalogDraftEditError('term_missing', 'remove_allowances must be a list of allowance keys');
    }
    for (const key of edits.remove_allowances) {
      if (key === CATALOG_ENVELOPE_ALLOWANCE_KEY) throw new CatalogDraftEditError('term_missing', `${CATALOG_ENVELOPE_ALLOWANCE_KEY} cannot be removed`, { term: key });
      if (!allowances.some((a) => a.allowance_key === key)) throw new CatalogDraftEditError('term_missing', `this version carries no ${key} allowance`, { term: key });
    }
    const drop = new Set(edits.remove_allowances);
    allowances = allowances.filter((a) => !drop.has(a.allowance_key));
    allowance_windows = allowance_windows.filter((w) => !drop.has(w.allowance_key));
  }
  if (edits.description !== undefined) {
    const d = edits.description === null ? null : typeof edits.description === 'string' ? edits.description.trim() : undefined;
    if (d === undefined || (d !== null && (d.length < 1 || d.length > MAX_CATALOG_DESCRIPTION_LENGTH))) {
      throw new CatalogDraftEditError('term_missing', `description must be 1..${MAX_CATALOG_DESCRIPTION_LENGTH} characters or null`);
    }
    plan = { ...plan, description: d };
  }
  if (edits.features !== undefined) {
    const product = content.plan.product_key;
    for (const [key, enabled] of Object.entries(edits.features)) {
      if (typeof enabled !== 'boolean') throw new CatalogDraftEditError('term_missing', `features.${key} must be true or false`, { term: key });
      if (!(key in FEATURE_AVAILABILITY) || featureProduct(key) !== product) {
        throw new CatalogDraftEditError('term_missing', `${key} is not a registered ${product} feature (feature-availability.ts)`, { term: key });
      }
      features = features.some((f) => f.feature_key === key)
        ? features.map((f) => (f.feature_key === key ? { ...f, enabled } : f))
        : [...features, { feature_key: key, enabled }];
    }
  }
  let edited: PlanVersionContent;
  try {
    edited = parsePlanVersionContent({ ...content, plan, allowances, allowance_windows, capacities, features, ...(terms === undefined ? {} : { terms }) });
  } catch (e) {
    if (e instanceof PlanVersionContentError) throw new CatalogDraftEditError('term_missing', e.message);
    throw e;
  }
  const priced = edits.unit_prices === undefined ? edited : applyUnitPriceEdits(edited, edits.unit_prices);
  const regional = edits.regional_prices === undefined ? priced : applyRegionalPriceEdits(priced, edits.regional_prices);
  const united = edits.price_unit === undefined ? regional : applyPriceUnitEdit(regional, edits.price_unit);
  return edits.annual_commit_price_minor === undefined ? united : applyAnnualCommitPriceEdit(united, edits.annual_commit_price_minor);
}

/**
 * Billing terms (§3.1) — set (a price) or remove (null) the ANNUAL_COMMIT term of a DRAFT. Setting it on a
 * version without explicit terms gives it explicit terms: MONTHLY at the list price with no commitment.
 */
export function applyAnnualCommitPriceEdit(content: PlanVersionContent, price: number | null): PlanVersionContent {
  if (price !== null && (!nonNegInt(price) || price < 1 || price > MAX_TERM_PRICE_MINOR)) {
    throw new CatalogDraftEditError('term_missing', `annual_commit_price_minor must be an integer 1..${MAX_TERM_PRICE_MINOR} (minor units) or null`, { term: 'ANNUAL_COMMIT' });
  }
  if (isContractPriced(content)) throw new CatalogDraftEditError('contract_priced', 'this plan is contract-priced: it has no billing terms');
  const refusal = billingTermsRefusal(content.plan);
  if (refusal !== null) throw new CatalogDraftEditError('term_missing', `this plan cannot carry billing terms: ${refusal}`, { term: 'ANNUAL_COMMIT' });
  const monthly_price = content.plan.list_price_minor as number;
  if (monthly_price < 1) throw new CatalogDraftEditError('term_missing', 'a plan with billing terms needs a MONTHLY list price of at least 1 (minor units)', { term: 'MONTHLY' });
  const monthly: PlanVersionBillingTerm = { term: 'MONTHLY', list_price_minor: monthly_price, commitment_months: null };
  // Removing the annual term of a version WITHOUT explicit terms changes nothing.
  if (price === null && !hasExplicitTerms(content)) return content;
  const next: PlanVersionBillingTerm[] = price === null ? [monthly] : [monthly, { term: 'ANNUAL_COMMIT', list_price_minor: price, commitment_months: ANNUAL_COMMIT_MONTHS }];
  try {
    return withBillingTerms(content, next);
  } catch (e) {
    if (e instanceof PlanVersionContentError) throw new CatalogDraftEditError('term_missing', e.message);
    throw e;
  }
}

/** Per-seat pricing — the price unit of a DRAFT (SEAT only on a BUSINESS self-service plan with a list price). */
export function applyPriceUnitEdit(content: PlanVersionContent, unit: PlanPriceUnit): PlanVersionContent {
  if (unit !== 'SEAT' && unit !== 'ACCOUNT') throw new CatalogDraftEditError('term_missing', 'price_unit must be ACCOUNT or SEAT');
  if (unit === 'SEAT') {
    const refusal = seatPriceUnitRefusal(content.plan);
    if (refusal !== null) throw new CatalogDraftEditError('price_unit_not_applicable', `this plan cannot be priced per seat: ${refusal}`, { tenant_kind: content.plan.tenant_kind, sales_model: content.plan.sales_model });
  }
  return withPriceUnit(content, unit);
}

/** M-A12 A1-3 — the regional-price edits of a DRAFT (fails closed: a bad country, currency, interval or amount). */
export function applyRegionalPriceEdits(content: PlanVersionContent, edits: readonly CatalogRegionalPriceEdit[]): PlanVersionContent {
  if (!Array.isArray(edits)) throw new CatalogDraftEditError('term_missing', 'regional_prices must be an array of regional price edits');
  if (isContractPriced(content)) throw new CatalogDraftEditError('contract_priced', 'this plan is contract-priced: it has no regional list price');
  const byKey = new Map<string, PlanVersionRegionalPriceTerm>((content.regional_prices ?? []).map((r) => [`${r.country}:${r.interval}`, r]));
  for (const e of edits) {
    const country = typeof e?.country === 'string' ? e.country.trim().toUpperCase() : '';
    const currency = typeof e?.currency === 'string' ? e.currency.trim().toUpperCase() : '';
    if (!/^[A-Z]{2}$/.test(country)) throw new CatalogDraftEditError('term_missing', 'a regional price needs an ISO 3166-1 alpha-2 country');
    if (country === 'US') throw new CatalogDraftEditError('term_missing', 'US is the plan list price, not a regional price', { term: 'US' });
    if (e.interval !== 'MONTH' && e.interval !== 'YEAR') throw new CatalogDraftEditError('term_missing', 'a regional price interval is MONTH or YEAR', { term: country });
    const key = `${country}:${e.interval}`;
    if (e.amount_minor === null) {
      byKey.delete(key);
      continue;
    }
    if (!/^[A-Z]{3}$/.test(currency)) throw new CatalogDraftEditError('term_missing', 'a regional price needs an ISO 4217 currency', { term: country });
    if (!nonNegInt(e.amount_minor) || e.amount_minor > MAX_REGIONAL_PRICE_MINOR) {
      throw new CatalogDraftEditError('term_missing', `the regional price for ${country} must be an integer 0..${MAX_REGIONAL_PRICE_MINOR} (minor units)`, { term: country });
    }
    byKey.set(key, { country, currency, amount_minor: e.amount_minor, interval: e.interval });
  }
  try {
    return withRegionalPrices(content, [...byKey.values()]);
  } catch (e) {
    if (e instanceof PlanVersionContentError) throw new CatalogDraftEditError('term_missing', e.message);
    throw e;
  }
}

/** A4 D2 — the unit-price edits of a DRAFT (fails closed: an unknown unit, another product's unit, a bad price). */
function applyUnitPriceEdits(content: PlanVersionContent, edits: Readonly<Record<string, number | null>>): PlanVersionContent {
  if (typeof edits !== 'object' || edits === null || Array.isArray(edits)) throw new CatalogDraftEditError('term_missing', 'unit_prices must be an object of unit key to price');
  const prices = new Map<string, number>((content.unit_prices ?? []).map((u) => [u.unit_key, u.unit_price_minor]));
  for (const [unit_key, price] of Object.entries(edits)) {
    if (!isMeteredUnitKey(unit_key)) throw new CatalogDraftEditError('term_missing', `${unit_key} is not a metered add-on unit`, { term: unit_key });
    if (unit_key.split('.', 1)[0] !== content.plan.product_key) {
      throw new CatalogDraftEditError('term_missing', `${unit_key} is not an add-on of product ${content.plan.product_key}`, { term: unit_key });
    }
    if (price === null) {
      prices.delete(unit_key);
      continue;
    }
    if (!nonNegInt(price) || price > MAX_UNIT_PRICE_MINOR) {
      throw new CatalogDraftEditError('term_missing', `the unit price of ${unit_key} must be an integer 0..${MAX_UNIT_PRICE_MINOR} (minor units)`, { term: unit_key });
    }
    prices.set(unit_key, price);
  }
  try {
    return withUnitPrices(content, prices);
  } catch (e) {
    if (e instanceof PlanVersionContentError) throw new CatalogDraftEditError('term_missing', e.message);
    throw e;
  }
}
