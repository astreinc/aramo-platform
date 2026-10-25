import { createHash } from 'node:crypto';

import { canonicalJson } from './commercial/commercial-policy.js';

// CCP-A5 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1 row A5; MP-A2 N-15…N-19) — the
// versioned commercial content of a plan.
//
//   content (format 1)  the commercial projection of the live rows, byte for byte:
//                       plan = every Plan column except id, created_at and the operational
//                       catalog columns (sellable, status, display_order, activation_note);
//                       allowances / allowance_windows / capacities / features = the child rows in
//                       their STORED order (the order the catalog and account reads have always
//                       presented them: those reads never ordered them). The SQL projection
//                       subscription.ccp_plan_live_content (migration 20261025160000) builds the
//                       same document; the slice spec pins the two together.
//   checksum            SHA-256 (hex) of canonicalJson(content). A DB CHECK recomputes it with
//                       the SQL canonicalizer, so a stored row cannot disagree with its content.
//   terms               the parsed, checksum-verified content. Effective limits and terms are
//                       read from the subscription's PINNED version (MP-A2 N-3(c), N-18), so a
//                       later version never changes an existing subscriber (grandfathering).
//                       A malformed or tampered row fails closed (PlanVersionContentError).

export const PLAN_VERSION_CONTENT_FORMAT = 1;
export const PLAN_VERSION_STATUSES = ['DRAFT', 'PUBLISHED', 'RETIRED'] as const;
export type PlanVersionStatus = (typeof PLAN_VERSION_STATUSES)[number];

/** The pin reason the TenantSubscription trigger requires on a re-pin (closed CHECK). */
export const PIN_REASON_PROVIDER_PLAN_CHANGE = 'PROVIDER_PLAN_CHANGE';

export interface PlanVersionPlanTerms {
  readonly key: string;
  readonly product_key: string;
  readonly name: string;
  readonly description: string | null;
  readonly tenant_kind: string | null;
  readonly sales_model: string;
  readonly list_price_minor: number | null;
  readonly currency: string | null;
  readonly reference_price_minor: number | null;
  readonly reference_price_substantiated: boolean;
  readonly billing_interval: string | null;
  readonly commitment_months: number | null;
  readonly eligibility: string | null;
  readonly support_tier: string | null;
}

export interface PlanVersionAllowance {
  readonly allowance_key: string;
  readonly included_quantity: number | null;
  readonly unlimited: boolean;
  readonly period: string;
}

export interface PlanVersionAllowanceWindow {
  readonly allowance_key: string;
  readonly window_kind: string;
  readonly limit_quantity: number;
}

export interface PlanVersionCapacity {
  readonly capacity_key: string;
  readonly limit_quantity: number | null;
  readonly unlimited: boolean;
}

export interface PlanVersionFeature {
  readonly feature_key: string;
  readonly enabled: boolean;
}

export interface PlanVersionContent {
  readonly format: 1;
  readonly plan: PlanVersionPlanTerms;
  readonly allowances: readonly PlanVersionAllowance[];
  readonly allowance_windows: readonly PlanVersionAllowanceWindow[];
  readonly capacities: readonly PlanVersionCapacity[];
  readonly features: readonly PlanVersionFeature[];
}

export class PlanVersionContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanVersionContentError';
  }
}

/** The live-row shapes the projection reads (Prisma rows of Plan and its children). */
export interface LivePlanRows {
  readonly plan: {
    key: string;
    product_key: string;
    name: string;
    description: string | null;
    tenant_kind: string | null;
    sales_model: string;
    list_price_minor: number | null;
    currency: string | null;
    reference_price_minor: number | null;
    reference_price_substantiated: boolean;
    billing_interval: string | null;
    commitment_months: number | null;
    eligibility: string | null;
    support_tier: string | null;
  };
  readonly allowances: readonly { allowance_key: string; included_quantity: number | null; unlimited: boolean; period: string }[];
  readonly allowance_windows: readonly { allowance_key: string; window_kind: string; limit_quantity: number }[];
  readonly capacities: readonly { capacity_key: string; limit_quantity: bigint | number | null; unlimited: boolean }[];
  readonly features: readonly { feature_key: string; enabled: boolean }[];
}

function safeInt(v: bigint | number | null, what: string): number | null {
  if (v === null) return null;
  const n = typeof v === 'bigint' ? Number(v) : v;
  if (!Number.isSafeInteger(n)) throw new PlanVersionContentError(`${what} is not a safe integer`);
  return n;
}

/**
 * The format-1 content of a plan, projected from its live rows (the v1 / drafting source). The
 * child arrays keep the order they are given in (the caller reads them in stored order).
 */
export function planVersionContentFromRows(rows: LivePlanRows): PlanVersionContent {
  const p = rows.plan;
  return {
    format: 1,
    plan: {
      key: p.key,
      product_key: p.product_key,
      name: p.name,
      description: p.description,
      tenant_kind: p.tenant_kind,
      sales_model: p.sales_model,
      list_price_minor: p.list_price_minor,
      currency: p.currency,
      reference_price_minor: p.reference_price_minor,
      reference_price_substantiated: p.reference_price_substantiated,
      billing_interval: p.billing_interval,
      commitment_months: p.commitment_months,
      eligibility: p.eligibility,
      support_tier: p.support_tier,
    },
    allowances: rows.allowances.map((a) => ({ allowance_key: a.allowance_key, included_quantity: a.included_quantity, unlimited: a.unlimited, period: a.period })),
    allowance_windows: rows.allowance_windows.map((w) => ({ allowance_key: w.allowance_key, window_kind: w.window_kind, limit_quantity: w.limit_quantity })),
    capacities: rows.capacities.map((c) => ({ capacity_key: c.capacity_key, limit_quantity: safeInt(c.limit_quantity, `capacity ${c.capacity_key}`), unlimited: c.unlimited })),
    features: rows.features.map((f) => ({ feature_key: f.feature_key, enabled: f.enabled })),
  };
}

/** SHA-256 (lower-case hex) of the canonical JSON of a plan-version content document. */
export function planVersionChecksum(content: unknown): string {
  return createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex');
}

// ---- strict parser (fail closed) -------------------------------------------------------------

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function exactKeys(o: Obj, keys: readonly string[], where: string): void {
  const got = Object.keys(o).sort();
  const want = [...keys].sort();
  if (got.length !== want.length || got.some((k, i) => k !== want[i])) throw new PlanVersionContentError(`${where}: keys ${got.join(',')} are not ${want.join(',')}`);
}

function str(o: Obj, k: string, where: string): string {
  const v = o[k];
  if (typeof v !== 'string' || v === '') throw new PlanVersionContentError(`${where}.${k} must be a non-empty string`);
  return v;
}

function strOrNull(o: Obj, k: string, where: string): string | null {
  const v = o[k];
  if (v === null) return null;
  if (typeof v !== 'string') throw new PlanVersionContentError(`${where}.${k} must be a string or null`);
  return v;
}

function intOrNull(o: Obj, k: string, where: string): number | null {
  const v = o[k];
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new PlanVersionContentError(`${where}.${k} must be an integer or null`);
  return v;
}

function int(o: Obj, k: string, where: string): number {
  const v = intOrNull(o, k, where);
  if (v === null) throw new PlanVersionContentError(`${where}.${k} must be an integer`);
  return v;
}

function bool(o: Obj, k: string, where: string): boolean {
  const v = o[k];
  if (typeof v !== 'boolean') throw new PlanVersionContentError(`${where}.${k} must be a boolean`);
  return v;
}

function arr(o: Obj, k: string): Obj[] {
  const v = o[k];
  if (!Array.isArray(v) || !v.every(isObj)) throw new PlanVersionContentError(`content.${k} must be an array of objects`);
  return v;
}

const PLAN_KEYS = [
  'key', 'product_key', 'name', 'description', 'tenant_kind', 'sales_model', 'list_price_minor', 'currency', 'reference_price_minor',
  'reference_price_substantiated', 'billing_interval', 'commitment_months', 'eligibility', 'support_tier',
] as const;

/** Parse a stored content document strictly; any deviation from format 1 throws. */
export function parsePlanVersionContent(raw: unknown): PlanVersionContent {
  if (!isObj(raw)) throw new PlanVersionContentError('content must be an object');
  exactKeys(raw, ['format', 'plan', 'allowances', 'allowance_windows', 'capacities', 'features'], 'content');
  if (raw['format'] !== PLAN_VERSION_CONTENT_FORMAT) throw new PlanVersionContentError(`content.format must be ${PLAN_VERSION_CONTENT_FORMAT}`);
  const p = raw['plan'];
  if (!isObj(p)) throw new PlanVersionContentError('content.plan must be an object');
  exactKeys(p, PLAN_KEYS, 'content.plan');
  const W = 'content.plan';
  const plan: PlanVersionPlanTerms = {
    key: str(p, 'key', W),
    product_key: str(p, 'product_key', W),
    name: str(p, 'name', W),
    description: strOrNull(p, 'description', W),
    tenant_kind: strOrNull(p, 'tenant_kind', W),
    sales_model: str(p, 'sales_model', W),
    list_price_minor: intOrNull(p, 'list_price_minor', W),
    currency: strOrNull(p, 'currency', W),
    reference_price_minor: intOrNull(p, 'reference_price_minor', W),
    reference_price_substantiated: bool(p, 'reference_price_substantiated', W),
    billing_interval: strOrNull(p, 'billing_interval', W),
    commitment_months: intOrNull(p, 'commitment_months', W),
    eligibility: strOrNull(p, 'eligibility', W),
    support_tier: strOrNull(p, 'support_tier', W),
  };
  const allowances = arr(raw, 'allowances').map((a, i) => {
    const w = `content.allowances[${i}]`;
    exactKeys(a, ['allowance_key', 'included_quantity', 'unlimited', 'period'], w);
    return { allowance_key: str(a, 'allowance_key', w), included_quantity: intOrNull(a, 'included_quantity', w), unlimited: bool(a, 'unlimited', w), period: str(a, 'period', w) };
  });
  const allowance_windows = arr(raw, 'allowance_windows').map((a, i) => {
    const w = `content.allowance_windows[${i}]`;
    exactKeys(a, ['allowance_key', 'window_kind', 'limit_quantity'], w);
    return { allowance_key: str(a, 'allowance_key', w), window_kind: str(a, 'window_kind', w), limit_quantity: int(a, 'limit_quantity', w) };
  });
  const capacities = arr(raw, 'capacities').map((a, i) => {
    const w = `content.capacities[${i}]`;
    exactKeys(a, ['capacity_key', 'limit_quantity', 'unlimited'], w);
    return { capacity_key: str(a, 'capacity_key', w), limit_quantity: intOrNull(a, 'limit_quantity', w), unlimited: bool(a, 'unlimited', w) };
  });
  const features = arr(raw, 'features').map((a, i) => {
    const w = `content.features[${i}]`;
    exactKeys(a, ['feature_key', 'enabled'], w);
    return { feature_key: str(a, 'feature_key', w), enabled: bool(a, 'enabled', w) };
  });
  for (const [name, keys] of [
    ['allowances', allowances.map((a) => a.allowance_key)],
    ['allowance_windows', allowance_windows.map((a) => `${a.allowance_key}\u0000${a.window_kind}`)],
    ['capacities', capacities.map((a) => a.capacity_key)],
    ['features', features.map((a) => a.feature_key)],
  ] as const) {
    if (new Set(keys).size !== keys.length) throw new PlanVersionContentError(`content.${name} has a duplicate key`);
  }
  return { format: 1, plan, allowances, allowance_windows, capacities, features };
}

/**
 * The checksum-verified, parsed terms of a stored version row. A row whose checksum does not
 * match its content (impossible past the DB CHECK, but never trusted) or whose content is not
 * format 1 throws: no limit is ever read from an unverified version.
 */
export function planVersionTerms(row: { id: string; content: unknown; content_checksum: string }): PlanVersionContent {
  if (planVersionChecksum(row.content) !== row.content_checksum) throw new PlanVersionContentError(`plan version ${row.id}: checksum mismatch`);
  return parsePlanVersionContent(row.content);
}
