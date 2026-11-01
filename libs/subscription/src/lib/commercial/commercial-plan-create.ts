import { FEATURE_AVAILABILITY, type FeatureAvailability, isFeatureAvailable } from '../feature-availability.js';
import { type PlanVersionContent, planVersionContentFromRows } from '../plan-version.js';
import { PRODUCT_KEYS, ProductContextError, productOfMeteredKey } from '../product-registry.js';

// CCP PLAN_CREATE (Aramo-CCP-Amendment-PLAN_CREATE-Console-Plan-Creation, catalog row 17; authorized by
// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §5 "Related work") — the PURE half of the
// governed plan creation: the closed payload schema (PC-3), the available-capability rule (PC-4), the
// pricing rules per sales channel, and the rows and format-1 content the apply writes (PC-7). No I/O.
//
// The payload is the WHOLE plan definition the approvers approve (frozen by the payload checksum). The
// apply creates exactly these rows, then version 1 from them; nothing is defaulted or invented beyond
// the fixed operator columns (status ACTIVE, sellable false, no activation note, no reference price).

/** PC-3 — the closed payload key set. */
export const PLAN_CREATE_PAYLOAD_KEYS = [
  'plan_key',
  'product_key',
  'tenant_kind',
  'sales_model',
  'name',
  'description',
  'list_price_minor',
  'currency',
  'billing_interval',
  'commitment_months',
  'eligibility',
  'support_tier',
  'display_order',
  'allowances',
  'allowance_windows',
  'capacities',
  'features',
] as const;

export const PLAN_CREATE_TENANT_KINDS = ['PERSONAL', 'BUSINESS'] as const;
/** The sales channels a console-created plan may use (never OPERATOR: PC-11). */
export const PLAN_CREATE_SALES_MODELS = ['SELF_SERVICE', 'FREE', 'CONTACT_SALES'] as const;
export const PLAN_CREATE_ELIGIBILITY = ['ATS_SUBSCRIPTION'] as const;
export const PLAN_CREATE_SUPPORT_TIERS = ['BASIC', 'CONTRACTED'] as const;
/** v1 locks (schema CHECKs): USD, monthly invoices, monthly allowances, day windows. */
export const PLAN_CREATE_CURRENCY = 'USD';
export const PLAN_CREATE_BILLING_INTERVAL = 'MONTH';
export const PLAN_CREATE_ALLOWANCE_PERIOD = 'MONTHLY';
export const PLAN_CREATE_WINDOW_KIND = 'DAY';
/** Display orders at or above 900 are operator plans, never presented (subscription-lifecycle OPERATOR_DISPLAY_ORDER_FLOOR). */
export const PLAN_CREATE_MAX_DISPLAY_ORDER = 899;
export const PLAN_CREATE_LIMITS = { allowances: 16, allowance_windows: 8, capacities: 16, features: 32 } as const;
/** The plan-key shape (the catalog plan-key rule of the A6 payloads). */
export const PLAN_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,99}$/;

/** PC-6 — the stable refusal reasons of a duplicate plan key (409). */
export const PLAN_KEY_TAKEN = 'plan_key_taken';
export const PLAN_CREATE_OPEN = 'plan_create_open';

export interface PlanCreatePayload {
  plan_key: string;
  product_key: string;
  tenant_kind: (typeof PLAN_CREATE_TENANT_KINDS)[number];
  sales_model: (typeof PLAN_CREATE_SALES_MODELS)[number];
  name: string;
  description: string | null;
  list_price_minor: number | null;
  currency: string | null;
  billing_interval: string | null;
  commitment_months: number | null;
  eligibility: string | null;
  support_tier: string | null;
  display_order: number;
  allowances: Array<{ allowance_key: string; included_quantity: number | null; unlimited: boolean; period: string }>;
  allowance_windows: Array<{ allowance_key: string; window_kind: string; limit_quantity: number }>;
  capacities: Array<{ capacity_key: string; limit_quantity: number | null; unlimited: boolean }>;
  features: Array<{ feature_key: string; enabled: boolean }>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const oneOf = <T extends string>(v: unknown, set: readonly T[]): v is T => typeof v === 'string' && (set as readonly string[]).includes(v);

/** PC-4 — every key the payload names: AVAILABLE and of the payload's product. */
function keyErrors(where: string, key: unknown, product_key: string, registry: Readonly<Record<string, FeatureAvailability>>): string[] {
  if (typeof key !== 'string' || key.length === 0 || key.length > 64) return [`${where} must be a capability key`];
  try {
    if (productOfMeteredKey(key) !== product_key) return [`${where} ${key} is not a ${product_key} capability`];
  } catch (e) {
    if (e instanceof ProductContextError) return [`${where} ${key} is not a ${product_key} capability`];
    throw e;
  }
  if (!isFeatureAvailable(key, registry)) return [`PLAN_CREATE_FEATURE_NOT_AVAILABLE: ${where} ${key} is not an available capability (feature-availability.ts)`];
  return [];
}

function listOf(p: Obj, k: string, max: number, errors: string[]): Obj[] {
  const v = p[k];
  if (!Array.isArray(v) || !v.every(isObj)) {
    errors.push(`${k} must be an array of objects`);
    return [];
  }
  if (v.length > max) errors.push(`${k} must have at most ${max} entries`);
  return v;
}

function exact(o: Obj, keys: readonly string[], where: string, errors: string[]): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) errors.push(`${where}.${k} is not a field of this action`);
  for (const k of keys) if (!(k in o)) errors.push(`${where}.${k} is required`);
}

/**
 * PC-3 / PC-4 — the PLAN_CREATE payload errors (empty = valid). Run at creation and again at apply
 * (the availability registry is re-read at apply: a capability withdrawn in between is refused).
 */
export function planCreatePayloadErrors(p: Obj, registry: Readonly<Record<string, FeatureAvailability>> = FEATURE_AVAILABILITY): string[] {
  const errors: string[] = [];
  exact(p, PLAN_CREATE_PAYLOAD_KEYS, 'payload', errors);
  if (typeof p['plan_key'] !== 'string' || !PLAN_KEY_PATTERN.test(p['plan_key'])) errors.push('plan_key must be 2 to 100 lower-case letters, digits or hyphens, starting with a letter or digit');
  const product = p['product_key'];
  const productOk = oneOf(product, PRODUCT_KEYS);
  if (!productOk) errors.push(`product_key must be one of ${PRODUCT_KEYS.join(', ')} (the product registry)`);
  if (!oneOf(p['tenant_kind'], PLAN_CREATE_TENANT_KINDS)) errors.push(`tenant_kind must be one of ${PLAN_CREATE_TENANT_KINDS.join(', ')}`);
  if (!oneOf(p['sales_model'], PLAN_CREATE_SALES_MODELS)) errors.push(`sales_model must be one of ${PLAN_CREATE_SALES_MODELS.join(', ')}`);
  if (typeof p['name'] !== 'string' || p['name'].trim().length === 0 || p['name'].length > 100 || p['name'] !== p['name'].trim()) errors.push('name must be 1 to 100 characters, without leading or trailing spaces');
  if (p['description'] !== null && !(typeof p['description'] === 'string' && p['description'].trim().length > 0 && p['description'].length <= 500)) {
    errors.push('description must be null or 1 to 500 characters');
  }
  // Pricing per sales channel (PC-3; PC-5: the chain approves this exact price).
  const price = p['list_price_minor'];
  switch (p['sales_model']) {
    case 'SELF_SERVICE':
      if (!isInt(price) || price < 1) errors.push('a SELF_SERVICE plan needs list_price_minor of at least 1 (minor units)');
      break;
    case 'FREE':
      if (price !== 0) errors.push('a FREE plan has list_price_minor 0');
      break;
    case 'CONTACT_SALES':
      if (price !== null) errors.push('a CONTACT_SALES plan has no list price (list_price_minor null: priced by contract)');
      break;
    default:
      break;
  }
  if (price === null) {
    if (p['currency'] !== null) errors.push('currency must be null when there is no list price');
    if (p['billing_interval'] !== null) errors.push('billing_interval must be null when there is no list price');
  } else {
    if (p['currency'] !== PLAN_CREATE_CURRENCY) errors.push(`currency must be ${PLAN_CREATE_CURRENCY}`);
    if (p['billing_interval'] !== PLAN_CREATE_BILLING_INTERVAL) errors.push(`billing_interval must be ${PLAN_CREATE_BILLING_INTERVAL}`);
  }
  const cm = p['commitment_months'];
  if (cm !== null && !(isInt(cm) && cm >= 1 && cm <= 120)) errors.push('commitment_months must be null or an integer between 1 and 120');
  if (p['eligibility'] !== null && !oneOf(p['eligibility'], PLAN_CREATE_ELIGIBILITY)) errors.push(`eligibility must be null or one of ${PLAN_CREATE_ELIGIBILITY.join(', ')}`);
  if (p['support_tier'] !== null && !oneOf(p['support_tier'], PLAN_CREATE_SUPPORT_TIERS)) errors.push(`support_tier must be null or one of ${PLAN_CREATE_SUPPORT_TIERS.join(', ')}`);
  const order = p['display_order'];
  if (!isInt(order) || order < 1 || order > PLAN_CREATE_MAX_DISPLAY_ORDER) errors.push(`display_order must be an integer between 1 and ${PLAN_CREATE_MAX_DISPLAY_ORDER}`);

  const productKey = productOk ? (product as string) : PRODUCT_KEYS[0];
  const quantity = (v: unknown): boolean => v === null || (isInt(v) && v >= 0);
  const allowances = listOf(p, 'allowances', PLAN_CREATE_LIMITS.allowances, errors);
  allowances.forEach((a, i) => {
    const w = `allowances[${i}]`;
    exact(a, ['allowance_key', 'included_quantity', 'unlimited', 'period'], w, errors);
    errors.push(...keyErrors(`${w}.allowance_key`, a['allowance_key'], productKey, registry));
    if (typeof a['unlimited'] !== 'boolean' || !quantity(a['included_quantity']) || a['unlimited'] !== (a['included_quantity'] === null)) {
      errors.push(`${w} must be unlimited (included_quantity null) or carry a non-negative included_quantity`);
    }
    if (a['period'] !== PLAN_CREATE_ALLOWANCE_PERIOD) errors.push(`${w}.period must be ${PLAN_CREATE_ALLOWANCE_PERIOD}`);
  });
  const allowanceKeys = allowances.map((a) => a['allowance_key']);
  const windows = listOf(p, 'allowance_windows', PLAN_CREATE_LIMITS.allowance_windows, errors);
  windows.forEach((a, i) => {
    const w = `allowance_windows[${i}]`;
    exact(a, ['allowance_key', 'window_kind', 'limit_quantity'], w, errors);
    if (!allowanceKeys.includes(a['allowance_key'])) errors.push(`${w}.allowance_key must name an allowance of this plan`);
    if (a['window_kind'] !== PLAN_CREATE_WINDOW_KIND) errors.push(`${w}.window_kind must be ${PLAN_CREATE_WINDOW_KIND}`);
    if (!isInt(a['limit_quantity']) || (a['limit_quantity'] as number) < 1) errors.push(`${w}.limit_quantity must be an integer of at least 1`);
  });
  const capacities = listOf(p, 'capacities', PLAN_CREATE_LIMITS.capacities, errors);
  capacities.forEach((c, i) => {
    const w = `capacities[${i}]`;
    exact(c, ['capacity_key', 'limit_quantity', 'unlimited'], w, errors);
    errors.push(...keyErrors(`${w}.capacity_key`, c['capacity_key'], productKey, registry));
    if (typeof c['unlimited'] !== 'boolean' || !quantity(c['limit_quantity']) || c['unlimited'] !== (c['limit_quantity'] === null)) {
      errors.push(`${w} must be unlimited (limit_quantity null) or carry a non-negative limit_quantity`);
    }
  });
  const features = listOf(p, 'features', PLAN_CREATE_LIMITS.features, errors);
  features.forEach((f, i) => {
    const w = `features[${i}]`;
    exact(f, ['feature_key', 'enabled'], w, errors);
    errors.push(...keyErrors(`${w}.feature_key`, f['feature_key'], productKey, registry));
    if (typeof f['enabled'] !== 'boolean') errors.push(`${w}.enabled must be a boolean`);
  });
  for (const [name, keys] of [
    ['allowances', allowanceKeys],
    ['allowance_windows', windows.map((a) => `${String(a['allowance_key'])}\u0000${String(a['window_kind'])}`)],
    ['capacities', capacities.map((c) => c['capacity_key'])],
    ['features', features.map((f) => f['feature_key'])],
  ] as const) {
    if (new Set(keys).size !== keys.length) errors.push(`${name} must not repeat a key`);
  }
  return errors;
}

/** PC-7 — the Plan row the apply creates (operator columns fixed: ACTIVE, not sellable, no note). */
export function planRowOf(p: PlanCreatePayload): {
  key: string;
  product_key: string;
  name: string;
  description: string | null;
  tenant_kind: string;
  sales_model: string;
  status: 'ACTIVE';
  sellable: false;
  list_price_minor: number | null;
  currency: string | null;
  reference_price_minor: null;
  reference_price_substantiated: false;
  billing_interval: string | null;
  commitment_months: number | null;
  eligibility: string | null;
  support_tier: string | null;
  activation_note: null;
  display_order: number;
} {
  return {
    key: p.plan_key,
    product_key: p.product_key,
    name: p.name,
    description: p.description,
    tenant_kind: p.tenant_kind,
    sales_model: p.sales_model,
    status: 'ACTIVE',
    sellable: false,
    list_price_minor: p.list_price_minor,
    currency: p.currency,
    reference_price_minor: null,
    reference_price_substantiated: false,
    billing_interval: p.billing_interval,
    commitment_months: p.commitment_months,
    eligibility: p.eligibility,
    support_tier: p.support_tier,
    activation_note: null,
    display_order: p.display_order,
  };
}

/** PC-7 — the format-1 content of version 1: the projection of exactly the rows the apply writes. */
export function planCreateContent(p: PlanCreatePayload): PlanVersionContent {
  return planVersionContentFromRows({
    plan: planRowOf(p),
    allowances: p.allowances,
    allowance_windows: p.allowance_windows,
    capacities: p.capacities,
    features: p.features,
  });
}

/** PC-4 — the capability keys a console-created plan may name now (the console form's choices). */
export function planCreateAvailableKeys(product_key: string, registry: Readonly<Record<string, FeatureAvailability>> = FEATURE_AVAILABILITY): string[] {
  return Object.keys(registry)
    .filter((k) => keyErrors('key', k, product_key, registry).length === 0)
    .sort();
}
