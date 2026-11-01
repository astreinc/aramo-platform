// CCP PLAN_CREATE (Aramo-CCP-Amendment-PLAN_CREATE-Console-Plan-Creation, catalog row 17) — the pure
// model of the Catalog screen's "New plan" form: the form state, its validation (the same rules the
// backend enforces, PC-3 / PC-4, so the commit button is honest), and the PLAN_CREATE payload it builds.
// The backend stays the authority: it re-validates the payload and refuses a taken key (PC-6).

export type NewPlanSalesModel = 'SELF_SERVICE' | 'FREE' | 'CONTACT_SALES';
export type NewPlanTenantKind = 'BUSINESS' | 'PERSONAL';

export interface NewPlanForm {
  readonly planKey: string;
  readonly name: string;
  readonly description: string;
  readonly tenantKind: NewPlanTenantKind;
  readonly salesModel: NewPlanSalesModel;
  /** Dollars per month (SELF_SERVICE only). */
  readonly price: string;
  readonly commitmentMonths: string;
  readonly atsRequired: boolean;
  readonly supportTier: '' | 'BASIC' | 'CONTRACTED';
  readonly displayOrder: string;
  /** Envelopes per month; '' when the plan has no envelope allowance. */
  readonly envelopes: string;
  readonly envelopesUnlimited: boolean;
  /** GB; '' when the plan has no storage capacity. */
  readonly storageGb: string;
  readonly storageUnlimited: boolean;
  /** Feature keys switched on (each must be AVAILABLE). */
  readonly features: readonly string[];
}

/** The allowance and capacity the form edits (the rest of the AVAILABLE keys are feature switches). */
export const NEW_PLAN_ENVELOPE_KEY = 'sign.envelopes';
export const NEW_PLAN_STORAGE_KEY = 'sign.storage_bytes';

export const NEW_PLAN_SALES_MODELS: readonly { readonly key: NewPlanSalesModel; readonly label: string }[] = [
  { key: 'SELF_SERVICE', label: 'Self-service (monthly price)' },
  { key: 'FREE', label: 'Free' },
  { key: 'CONTACT_SALES', label: 'Contact sales (priced by contract)' },
];

export const FEATURE_LABEL: Readonly<Record<string, string>> = {
  'sign.team_collaboration': 'Team collaboration',
  'sign.in_person_signing': 'In-person signing',
};
export const featureLabel = (key: string): string => FEATURE_LABEL[key] ?? key;

export const EMPTY_NEW_PLAN: NewPlanForm = {
  planKey: '',
  name: '',
  description: '',
  tenantKind: 'BUSINESS',
  salesModel: 'SELF_SERVICE',
  price: '',
  commitmentMonths: '',
  atsRequired: false,
  supportTier: 'BASIC',
  displayOrder: '100',
  envelopes: '',
  envelopesUnlimited: false,
  storageGb: '',
  storageUnlimited: false,
  features: [],
};

const PLAN_KEY = /^[a-z0-9][a-z0-9-]{1,99}$/;
const GIB = 1024 ** 3;

/** The capability keys offered as feature switches: the AVAILABLE keys that are not the envelope allowance or the storage capacity. */
export function featureChoices(availableKeys: readonly string[]): string[] {
  return availableKeys.filter((k) => k !== NEW_PLAN_ENVELOPE_KEY && k !== NEW_PLAN_STORAGE_KEY);
}

function wholeNumber(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

/** Dollars (up to 2 decimals) → minor units; null when not a valid amount. */
export function dollarsToMinor(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Math.round(Number(t) * 100);
  return Number.isSafeInteger(n) ? n : null;
}

export interface NewPlanPayload {
  plan_key: string;
  product_key: 'sign';
  tenant_kind: NewPlanTenantKind;
  sales_model: NewPlanSalesModel;
  name: string;
  description: string | null;
  list_price_minor: number | null;
  currency: string | null;
  billing_interval: string | null;
  commitment_months: number | null;
  eligibility: string | null;
  support_tier: string | null;
  display_order: number;
  allowances: { allowance_key: string; included_quantity: number | null; unlimited: boolean; period: 'MONTHLY' }[];
  allowance_windows: never[];
  capacities: { capacity_key: string; limit_quantity: number | null; unlimited: boolean }[];
  features: { feature_key: string; enabled: boolean }[];
}

/**
 * Validates the form and builds the PLAN_CREATE payload. `errors` lists every problem (empty = the
 * request can be submitted). Every AVAILABLE feature switch is listed (enabled or not), so the plan
 * states each built capability explicitly; nothing NOT_AVAILABLE is ever named (PC-4).
 */
export function buildNewPlanPayload(f: NewPlanForm, availableKeys: readonly string[], existingKeys: readonly string[] = []): { payload: NewPlanPayload | null; errors: string[] } {
  const errors: string[] = [];
  const key = f.planKey.trim();
  if (!PLAN_KEY.test(key)) errors.push('Plan key: 2 to 100 lower-case letters, digits or hyphens.');
  else if (existingKeys.includes(key)) errors.push('Plan key: a plan with this key already exists.');
  const name = f.name.trim();
  if (name.length === 0 || name.length > 100) errors.push('Name: 1 to 100 characters.');
  const description = f.description.trim();
  if (description.length > 500) errors.push('Description: at most 500 characters.');
  let price: number | null = null;
  if (f.salesModel === 'SELF_SERVICE') {
    price = dollarsToMinor(f.price);
    if (price === null || price < 1) errors.push('Price: a monthly price of at least $0.01.');
  } else if (f.salesModel === 'FREE') price = 0;
  let commitment: number | null = null;
  if (f.commitmentMonths.trim() !== '') {
    commitment = wholeNumber(f.commitmentMonths);
    if (commitment === null || commitment < 1 || commitment > 120) errors.push('Commitment: 1 to 120 months, or empty.');
  }
  const order = wholeNumber(f.displayOrder);
  if (order === null || order < 1 || order > 899) errors.push('Display order: 1 to 899.');
  const allowances: NewPlanPayload['allowances'] = [];
  if (availableKeys.includes(NEW_PLAN_ENVELOPE_KEY) && (f.envelopesUnlimited || f.envelopes.trim() !== '')) {
    const q = f.envelopesUnlimited ? null : wholeNumber(f.envelopes);
    if (!f.envelopesUnlimited && q === null) errors.push('Envelopes per month: a whole number, or unlimited.');
    else allowances.push({ allowance_key: NEW_PLAN_ENVELOPE_KEY, included_quantity: q, unlimited: f.envelopesUnlimited, period: 'MONTHLY' });
  }
  const capacities: NewPlanPayload['capacities'] = [];
  if (availableKeys.includes(NEW_PLAN_STORAGE_KEY) && (f.storageUnlimited || f.storageGb.trim() !== '')) {
    const gb = f.storageUnlimited ? null : wholeNumber(f.storageGb);
    if (!f.storageUnlimited && gb === null) errors.push('Storage: whole GB, or unlimited.');
    else capacities.push({ capacity_key: NEW_PLAN_STORAGE_KEY, limit_quantity: gb === null ? null : gb * GIB, unlimited: f.storageUnlimited });
  }
  const choices = featureChoices(availableKeys);
  for (const k of f.features) if (!choices.includes(k)) errors.push(`Feature ${k} is not available.`);
  if (errors.length > 0) return { payload: null, errors };
  return {
    payload: {
      plan_key: key,
      product_key: 'sign',
      tenant_kind: f.tenantKind,
      sales_model: f.salesModel,
      name,
      description: description === '' ? null : description,
      list_price_minor: price,
      currency: price === null ? null : 'USD',
      billing_interval: price === null ? null : 'MONTH',
      commitment_months: commitment,
      eligibility: f.atsRequired ? 'ATS_SUBSCRIPTION' : null,
      support_tier: f.supportTier === '' ? null : f.supportTier,
      display_order: order as number,
      allowances,
      allowance_windows: [],
      capacities,
      features: choices.map((k) => ({ feature_key: k, enabled: f.features.includes(k) })),
    },
    errors,
  };
}

/** The summary rows the dialog shows (field → value), from a valid payload. */
export function newPlanSummary(p: NewPlanPayload): { field: string; value: string }[] {
  const money = (m: number) => `$${(m / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  const env = p.allowances.find((a) => a.allowance_key === NEW_PLAN_ENVELOPE_KEY);
  const sto = p.capacities.find((c) => c.capacity_key === NEW_PLAN_STORAGE_KEY);
  return [
    { field: 'Plan', value: `${p.name} (${p.plan_key})` },
    { field: 'For', value: p.tenant_kind === 'PERSONAL' ? 'Personal accounts' : 'Business organizations' },
    { field: 'Price', value: p.list_price_minor === null ? 'By contract' : p.list_price_minor === 0 ? 'Free' : `${money(p.list_price_minor)} / month` },
    { field: 'Envelopes per month', value: env === undefined ? 'Not included' : env.unlimited ? 'Unlimited' : String(env.included_quantity) },
    { field: 'Storage', value: sto === undefined ? 'Not included' : sto.unlimited ? 'Unlimited' : `${String((sto.limit_quantity ?? 0) / GIB)} GB` },
    { field: 'Features', value: p.features.filter((x) => x.enabled).map((x) => featureLabel(x.feature_key)).join(', ') || 'None' },
  ];
}

/** The pending-creation line: "Team (aramo-sign-team-v2) · pending approval". */
export function pendingPlanCreateLine(r: { readonly name: string; readonly plan_key: string; readonly state: string }): string {
  const state: Readonly<Record<string, string>> = {
    DRAFT: 'draft',
    PENDING_APPROVAL: 'pending approval',
    APPROVED: 'approved, waiting to be applied',
    APPLYING: 'applying',
    APPLY_FAILED: 'apply failed',
  };
  return `${r.name} (${r.plan_key}) · ${state[r.state] ?? r.state.toLowerCase()}`;
}

/** The requester applies an approved (or failed) creation (TD-B2-3: requester-only; the server re-checks). */
export function planCreateApplyable(r: { readonly state: string; readonly requested_by: string }, me: string): boolean {
  return r.requested_by === me && (r.state === 'APPROVED' || r.state === 'APPLY_FAILED');
}
