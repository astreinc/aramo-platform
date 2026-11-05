import {
  MAX_REGIONAL_PRICE_MINOR,
  MAX_UNIT_PRICE_MINOR,
  type PlanVersionContent,
  PlanVersionContentError,
  type PlanVersionRegionalPriceTerm,
  parsePlanVersionContent,
  withRegionalPrices,
  withUnitPrices,
} from '../plan-version.js';
import { isMeteredUnitKey } from '../usage/metered-units.js';

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

/** The Sign envelope allowance the editor's "Envelopes per month" reads and edits. */
export const CATALOG_ENVELOPE_ALLOWANCE_KEY = 'sign.envelopes';
/** The Sign storage capacity the editor's "Storage (GB)" reads and edits (binary bytes). */
export const CATALOG_STORAGE_CAPACITY_KEY = 'sign.storage_bytes';
/** v1 release limitation: only monthly USD versions (the schema supports more). */
export const CATALOG_V1_CURRENCY = 'USD';
export const CATALOG_V1_BILLING_INTERVAL = 'MONTH';

export type CatalogConflictReason = 'not_draft' | 'draft_exists' | 'stale' | 'plan_mismatch' | 'contract_priced' | 'term_missing';

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
}

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
  };
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
  const edited = parsePlanVersionContent({ ...content, plan, allowances, capacities });
  const priced = edits.unit_prices === undefined ? edited : applyUnitPriceEdits(edited, edits.unit_prices);
  return edits.regional_prices === undefined ? priced : applyRegionalPriceEdits(priced, edits.regional_prices);
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
