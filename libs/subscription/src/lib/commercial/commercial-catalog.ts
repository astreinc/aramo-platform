import { type PlanVersionContent, parsePlanVersionContent } from '../plan-version.js';

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
}

export interface CatalogDraftEdits {
  /** Minor units; a non-negative integer. Refused on a contract-priced plan. */
  readonly list_price_minor?: number;
  /** A non-negative integer, or null for unlimited. */
  readonly envelopes_per_month?: number | null;
  /** Binary bytes; a non-negative integer, or null for unlimited. */
  readonly storage_bytes?: number | null;
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
  return parsePlanVersionContent({ ...content, plan, allowances, capacities });
}
