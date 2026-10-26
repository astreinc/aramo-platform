import type { PillSpec } from '../../components';

import type { CatalogOpenRequest, CatalogPlan, CatalogVersion, CatalogVersionTerms, PlanVersionStatus } from './catalog-api';

// CCP-B2 — the pure view model of the Catalog screen (handoff §5.4; Commercial Control Plane
// v1.0.dc.html "// catalog"): every label, line and enabled/disabled decision is computed here
// from the API data so it can be unit-tested and so the screen stays a renderer.
//
// Published versions are read-only: `editorOf` never returns an editable field for a version
// that is not a DRAFT, and `versionActions` never offers an edit action for one (the only
// actions on a PUBLISHED version are "Create new draft from vN" and "Retire this version…").

/** Products shown on the Catalog. `sign` is the governed registry (CCP A4); the other three are
 * entitlement capabilities with no approved pricing, shown as "No commercial plans yet" and never
 * given a plan (Program Build Directive §7.1, §10). */
export const CATALOG_PRODUCTS: readonly { readonly key: string; readonly name: string }[] = [
  { key: 'sign', name: 'Aramo Sign' },
  { key: 'ats', name: 'ATS' },
  { key: 'portal', name: 'Portal' },
  { key: 'intelligence', name: 'Intelligence' },
];
export const NO_PLANS_LINE = 'No commercial plans yet — pricing not set';

export const VERSION_PILL: Readonly<Record<PlanVersionStatus, PillSpec>> = {
  PUBLISHED: { label: 'Published', tone: 'ok' },
  DRAFT: { label: 'Draft', tone: 'neutral' },
  RETIRED: { label: 'Retired', tone: 'muted' },
};

/** Change-request state → its lowercase label in "Publish request … is {state}." */
export const REQUEST_STATE_LABEL: Readonly<Record<string, string>> = {
  DRAFT: 'draft',
  PENDING_APPROVAL: 'pending approval',
  APPROVED: 'approved',
  APPLYING: 'applying',
  APPLIED: 'applied',
  APPLY_FAILED: 'apply failed',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  WITHDRAWN: 'withdrawn',
};

/** Approval-step role → the short step name (design STEP). */
export const STEP_LABEL: Readonly<Record<string, string>> = { finance_admin: 'Finance', platform_owner: 'Owner' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "15 Jan 2026" (UTC), the design's fD. */
export function formatDay(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getUTCDate())} ${MONTHS[d.getUTCMonth()] ?? ''} ${String(d.getUTCFullYear())}`;
}

/** "$59", "$19.99" — the design's money (whole dollars, up to 2 decimals). */
export function money(minor: number): string {
  return `$${(minor / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

const GIB = 1024 ** 3;
/** Binary bytes → GB, up to 3 decimals (the catalog stores binary units). */
export function storageGb(bytes: number): number {
  return Math.round((bytes / GIB) * 1000) / 1000;
}
export function gbToBytes(gb: number): number {
  return Math.round(gb * GIB);
}

export const planTitle = (plan: Pick<CatalogPlan, 'name'>): string => `Sign ${plan.name}`;
export const versionTitle = (plan: Pick<CatalogPlan, 'name'>, v: Pick<CatalogVersion, 'version_number'>): string => `Sign ${plan.name} v${String(v.version_number)}`;

/** Oldest first (the design lists versions v1, v2, v3). */
export function versionsAscending(plan: CatalogPlan): CatalogVersion[] {
  return [...plan.versions].sort((a, b) => a.version_number - b.version_number);
}

/** The latest PUBLISHED version (excluding `except`), or undefined. */
export function lastPublished(plan: CatalogPlan, except?: CatalogVersion): CatalogVersion | undefined {
  return versionsAscending(plan)
    .filter((v) => v.status === 'PUBLISHED' && v.id !== except?.id)
    .at(-1);
}

/** Whether a plan is contract-priced (no list price): its price is never edited or retired here. */
export function isContractOnly(plan: CatalogPlan): boolean {
  const latest = versionsAscending(plan).at(-1);
  return plan.sales_model === 'CONTACT_SALES' || (latest?.terms.contract_priced ?? false);
}

export function priceText(terms: CatalogVersionTerms): string {
  return terms.list_price_minor === null || terms.contract_priced ? 'Contract only' : `${money(terms.list_price_minor)} / mo`;
}

export interface PlanRowModel {
  readonly title: string;
  readonly price: string;
  readonly versions: string;
  readonly counts: string;
}

export function planRow(plan: CatalogPlan): PlanRowModel {
  const asc = versionsAscending(plan);
  const lp = lastPublished(plan);
  return {
    title: planTitle(plan),
    price: lp === undefined ? 'Not published' : priceText(lp.terms),
    versions: asc.map((v) => `v${String(v.version_number)} ${VERSION_PILL[v.status].label.toLowerCase()}`).join(' · '),
    counts: asc
      .filter((v) => v.status !== 'DRAFT')
      .map((v) => `${String(v.pinned_subscriptions)} on v${String(v.version_number)}`)
      .join(', '),
  };
}

/** "1 tenant(s) on v1 · 2 tenant(s) on v2. Subscriptions keep their pinned version." */
export function grandfatheringLine(plan: CatalogPlan): string {
  const parts = versionsAscending(plan)
    .filter((v) => v.status !== 'DRAFT')
    .map((v) => `${String(v.pinned_subscriptions)} tenant(s) on v${String(v.version_number)}`);
  return `${parts.join(' · ')}. Subscriptions keep their pinned version.`;
}

export function chipPinned(v: CatalogVersion): string {
  return v.status === 'DRAFT' ? '' : `${String(v.pinned_subscriptions)} pinned`;
}

export function versionMeta(v: CatalogVersion): string {
  if (v.status === 'DRAFT') return 'Editable draft';
  if (v.status === 'RETIRED') return `Retired ${formatDay(v.retired_at)}`;
  return `Published ${formatDay(v.published_at)}`;
}

export const LOCK_TEXT_PUBLISHED = 'Published versions are immutable. To change pricing or allowances, create a new draft.';
export const LOCK_TEXT_VIEW_ONLY = 'View only — editing a draft needs the Catalog manager role.';
export const V1_LOCK_TITLE = 'v1 release limitation — the schema supports more';
export const SEATS_TITLE = 'Not part of the Aramo Sign plan model: no seat limit is stored for Sign plans.';

export type EditorFieldKey = 'price' | 'envelopes' | 'seats' | 'storage';

export interface EditorField {
  readonly key: EditorFieldKey;
  readonly label: string;
  /** The input's value ('' when none). */
  readonly value: string;
  readonly placeholder: string;
  /** True = disabled (read-only). Always true on a PUBLISHED or RETIRED version. */
  readonly readOnly: boolean;
  /** The design's white (editable draft) or grey (read-only) input. */
  readonly editable: boolean;
  readonly title?: string;
}

export interface EditorModel {
  readonly title: string;
  readonly pill: PillSpec;
  readonly meta: string;
  /** The 🔒 line above the fields, or null on an editable draft. */
  readonly lockText: string | null;
  readonly fields: readonly EditorField[];
  readonly locks: readonly { readonly label: string; readonly value: string }[];
}

function termValue(key: EditorFieldKey, t: CatalogVersionTerms): { value: string; placeholder: string } {
  switch (key) {
    case 'price':
      return { value: t.list_price_minor === null ? '' : String(t.list_price_minor / 100), placeholder: t.contract_priced ? 'Contract' : '' };
    case 'envelopes':
      return { value: t.envelopes_per_month === null ? '' : String(t.envelopes_per_month), placeholder: t.envelopes_unlimited ? 'Unlimited' : '' };
    case 'storage':
      return { value: t.storage_bytes === null ? '' : String(storageGb(t.storage_bytes)), placeholder: t.storage_unlimited ? 'Unlimited' : '' };
    case 'seats':
      return { value: '', placeholder: '' };
  }
}

const FIELD_LABEL: Readonly<Record<EditorFieldKey, string>> = {
  price: 'Price per month (USD)',
  envelopes: 'Envelopes per month',
  seats: 'Seats',
  storage: 'Storage (GB)',
};
const FIELD_ORDER: readonly EditorFieldKey[] = ['price', 'envelopes', 'seats', 'storage'];

/**
 * The version editor. `canDraft` = the caller holds platform:catalog:draft. Only a DRAFT seen by a
 * drafter has editable fields; the price of a contract-priced plan, a term the version does not
 * carry and the seats field (no backing term) are never editable.
 */
export function editorOf(plan: CatalogPlan, v: CatalogVersion, canDraft: boolean, overrides: Partial<Record<EditorFieldKey, string>> = {}): EditorModel {
  const isDraft = v.status === 'DRAFT';
  const editable = isDraft && canDraft;
  const contractOnly = isContractOnly(plan);
  const fields = FIELD_ORDER.map((key): EditorField => {
    const base = termValue(key, v.terms);
    const missing = (key === 'envelopes' && !v.terms.envelopes_present) || (key === 'storage' && !v.terms.storage_present);
    const readOnly = !editable || key === 'seats' || (key === 'price' && contractOnly) || missing;
    return {
      key,
      label: FIELD_LABEL[key],
      value: overrides[key] ?? base.value,
      placeholder: base.placeholder,
      readOnly,
      editable,
      ...(key === 'seats' ? { title: SEATS_TITLE } : {}),
    };
  });
  return {
    title: versionTitle(plan, v),
    pill: VERSION_PILL[v.status],
    meta: versionMeta(v),
    lockText: !isDraft ? LOCK_TEXT_PUBLISHED : !canDraft ? LOCK_TEXT_VIEW_ONLY : null,
    fields,
    locks: [
      { label: 'Currency', value: 'USD' },
      { label: 'Billing interval', value: 'Monthly' },
    ],
  };
}

export interface DiffRowModel {
  readonly field: string;
  readonly before: string;
  readonly after: string;
  readonly changed: boolean;
}

function envelopesText(t: CatalogVersionTerms): string {
  if (!t.envelopes_present) return '—';
  return t.envelopes_unlimited || t.envelopes_per_month === null ? 'Unlimited' : t.envelopes_per_month.toLocaleString('en-US');
}
function storageText(t: CatalogVersionTerms): string {
  if (!t.storage_present) return '—';
  return t.storage_unlimited || t.storage_bytes === null ? 'Unlimited' : `${String(storageGb(t.storage_bytes))} GB`;
}
function priceDiffText(t: CatalogVersionTerms): string {
  return t.list_price_minor === null || t.contract_priced ? 'Contract only' : money(t.list_price_minor);
}

/**
 * Draft vs the latest published version (handoff §5.4 "Draft diff"). `labels` = 'editor' (the
 * card: Price / Envelopes / Seats / Storage) or 'dialog' (the publish dialog: "Envelopes per
 * month"). Seats have no backing term, so their row is "—" on both sides (never changed).
 */
export function draftDiff(before: CatalogVersionTerms, after: CatalogVersionTerms, labels: 'editor' | 'dialog'): DiffRowModel[] {
  const rows: [string, string, string][] = [
    ['Price', priceDiffText(before), priceDiffText(after)],
    [labels === 'dialog' ? 'Envelopes per month' : 'Envelopes', envelopesText(before), envelopesText(after)],
    ['Seats', '—', '—'],
    ['Storage', storageText(before), storageText(after)],
  ];
  return rows.map(([field, b, a]) => ({ field, before: b, after: a, changed: b !== a }));
}

export function pinnedLine(v: CatalogVersion, tenantNames: readonly string[] | null): string {
  if (v.status === 'DRAFT') return 'None — drafts take no subscriptions.';
  const names = tenantNames === null ? '…' : tenantNames.length > 0 ? tenantNames.join(', ') : 'No tenants';
  return names + (v.status === 'RETIRED' ? ' (grandfathered; no new subscriptions)' : '');
}

/** The open request shown under the editor ("Publish request … is pending approval."). */
export function openRequestOf(v: CatalogVersion): CatalogOpenRequest | null {
  return v.open_requests[0] ?? null;
}

export function openRequestSentence(r: CatalogOpenRequest): { lead: string; state: string } {
  return { lead: r.action_type === 'PLAN_RETIRE' ? 'Retire request' : 'Publish request', state: REQUEST_STATE_LABEL[r.state] ?? r.state.toLowerCase() };
}

export type ActionTone = 'terra' | 'sec';
export type CatalogActionKind = 'publish' | 'draft' | 'retire';

export interface CatalogActionModel {
  readonly kind: CatalogActionKind;
  readonly label: string;
  readonly tone: ActionTone;
  readonly disabled: boolean;
  /** The disabled reason (the button's tooltip). */
  readonly why: string;
}

export const NEEDS_CATALOG_MANAGER = 'Needs the Catalog manager role.';

/**
 * The version's actions (handoff §5.4 "Actions"): a DRAFT → "Request publish…"; a non-draft
 * version of a plan without a DRAFT → "Create new draft from vN"; a PUBLISHED, list-priced
 * version → "Retire this version…". There is NO edit action on a published version.
 * CCP-R3 (TD-B2-1, Architect 2026-10-25): PLAN_RETIRE retires the ONE version it names, never the
 * whole plan; the label says so. There is no whole-plan retire action.
 */
export const RETIRE_VERSION_LABEL = 'Retire this version…';
export function versionActions(plan: CatalogPlan, v: CatalogVersion, canDraft: boolean): CatalogActionModel[] {
  const out: CatalogActionModel[] = [];
  const open = v.open_requests;
  if (v.status === 'DRAFT') {
    const pending = open.some((r) => r.action_type === 'PLAN_VERSION_PUBLISH');
    out.push({
      kind: 'publish',
      label: 'Request publish…',
      tone: 'terra',
      disabled: !canDraft || pending,
      why: !canDraft ? NEEDS_CATALOG_MANAGER : pending ? 'A publish request is already open.' : '',
    });
  }
  if (v.status !== 'DRAFT' && !plan.versions.some((x) => x.status === 'DRAFT')) {
    out.push({ kind: 'draft', label: `Create new draft from v${String(v.version_number)}`, tone: 'sec', disabled: !canDraft, why: canDraft ? '' : NEEDS_CATALOG_MANAGER });
  }
  if (v.status === 'PUBLISHED' && !isContractOnly(plan)) {
    const pending = open.some((r) => r.action_type === 'PLAN_RETIRE');
    out.push({
      kind: 'retire',
      label: RETIRE_VERSION_LABEL,
      tone: 'sec',
      disabled: !canDraft || pending,
      why: !canDraft ? NEEDS_CATALOG_MANAGER : pending ? 'A retire request for this version is already open.' : '',
    });
  }
  return out;
}

export interface FieldParse {
  readonly ok: boolean;
  readonly value?: number | null;
}

/** A field's text → the PATCH value (minor units / count / bytes; '' = unlimited). */
export function parseFieldInput(key: Exclude<EditorFieldKey, 'seats'>, raw: string): FieldParse {
  const s = raw.trim();
  if (s === '') return key === 'price' ? { ok: false } : { ok: true, value: null };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  if (key === 'price') return { ok: true, value: Math.round(n * 100) };
  if (key === 'envelopes') return Number.isInteger(n) ? { ok: true, value: n } : { ok: false };
  return { ok: true, value: gbToBytes(n) };
}

/** The chain label for a catalog request (design CHAINS.CATALOG). */
export function chainLabelOf(rule: string): string {
  return rule === 'FINANCE_THEN_OWNER' ? 'Catalog publish' : rule === 'FINANCE_ONLY' ? 'Below threshold' : rule;
}

/** TD-A6-13: the apply affordance on an open catalog request — "Apply" once APPROVED, "Retry apply"
 * after APPLY_FAILED, none otherwise. Who may apply is decided by the server (the A6 apply route). */
export function applyActionOf(r: CatalogOpenRequest): { label: string } | null {
  if (r.state === 'APPROVED') return { label: 'Apply' };
  if (r.state === 'APPLY_FAILED') return { label: 'Retry apply' };
  return null;
}
