// CCP-B3 — the deterministic Subscriptions / Tenant › Commercial dataset for the visual, a11y,
// keyboard and 900px suites: a port of the CCP prototype's T0 tenants (ccp-data.js, CCP-UI v1.0)
// into the REAL CCP-B3 read shapes (apps/platform-web/src/commercial/subscriptions/
// subscriptions-api.ts), at the prototype's frozen clock (NOW = 2026-10-24 14:00 UTC). The plans
// and versions are CCP-B2's catalog fixture (e2e/fixtures/ccp-catalog.ts: ids `team`, `team-v2`…).
//
// Fixture notes (DIVERGENCES.md "CCP-B3", no mask): the rows come in the prototype's order (the
// server orders by tenant name; the design names no sort); Fernhill's and Quarry Lane's
// `current_period` reproduce the prototype's past (unpaid) period, which the server's
// billing-period rule would not return for an open row. The retired pilot policy v0 is not ported
// (Don't build); Meridian's release request CR-1051 is a CONVERSION in APPLYING with its Stripe
// command unconfirmed (C1 / C-23). TEST-ONLY: src/ never imports it.

import type { Handler, MockOptions } from './mock-api';
import type { Persona } from './session';

export const SUBS_NOW = '2026-10-24T14:00:00Z';
const POLICY_V1 = '019a0000-0000-7000-8000-0000000cc201';

export const B3_TENANTS = {
  halcyon: 'cb300000-0000-7000-8000-0000000000a1',
  atlas: 'cb300000-0000-7000-8000-0000000000a2',
  meridian: 'cb300000-0000-7000-8000-0000000000a3',
  northwind: 'cb300000-0000-7000-8000-0000000000a4',
  fernhill: 'cb300000-0000-7000-8000-0000000000a5',
  oakridge: 'cb300000-0000-7000-8000-0000000000a6',
  brightline: 'cb300000-0000-7000-8000-0000000000a7',
  quarry: 'cb300000-0000-7000-8000-0000000000a8',
} as const;
type Key = keyof typeof B3_TENANTS;

export const CR_1051 = 'cb300000-0000-7000-8000-000000001051';
const CR_1032 = 'cb300000-0000-7000-8000-000000001032';
const CR_0988 = 'cb300000-0000-7000-8000-000000000988';
// CR-1042: the prototype's pending account credit on Northwind (a CREDIT request holds the slot, Q14).
const CR_1042 = 'cb300000-0000-7000-8000-000000001042';

const PLAN_NAME: Readonly<Record<string, string>> = { starter: 'Starter', team: 'Team', business: 'Business', scale: 'Scale', enterprise: 'Enterprise' };
const RETIRED = new Set(['business-v1']);

const day = (d: string): string => `${d}T00:00:00.000Z`;
const plus1 = (d: string): string => new Date(Date.parse(day(d)) + 86_400_000).toISOString();

interface Seed {
  readonly name: string;
  readonly slug: string;
  readonly plan: string;
  readonly ver: number;
  readonly source: 'MANUAL' | 'SELF_SERVICE';
  readonly status: 'ACTIVE' | 'PAST_DUE';
  /** The period as the design shows it (first and last day). */
  readonly ps: string;
  readonly pe: string;
  readonly grace?: string;
  readonly ended?: string;
  readonly anchor?: string;
  readonly commitEnd?: string;
  readonly contract?: string;
  readonly used: number;
  readonly allow: number;
  readonly recon?: boolean;
  readonly ext?: boolean;
}

// ccp-data.js T0 (Sign subscriptions), in the prototype's order.
const T0: Readonly<Record<Key, Seed>> = {
  halcyon: { name: 'Halcyon Health', slug: 'halcyon', plan: 'enterprise', ver: 1, source: 'MANUAL', status: 'ACTIVE', ps: '2026-10-08', pe: '2026-11-07', commitEnd: '2026-12-08', contract: 'CT-2024-007', used: 18240, allow: 25000 },
  atlas: { name: 'Atlas Freight', slug: 'atlas-freight', plan: 'business', ver: 2, source: 'MANUAL', status: 'ACTIVE', ps: '2026-10-01', pe: '2026-10-31', commitEnd: '2027-04-30', contract: 'CT-2026-021', used: 2140, allow: 3000 },
  meridian: { name: 'Meridian Partners', slug: 'meridian', plan: 'scale', ver: 1, source: 'MANUAL', status: 'ACTIVE', ps: '2026-10-15', pe: '2026-11-14', commitEnd: '2027-03-14', contract: 'CT-2025-014', used: 4410, allow: 10000, recon: true },
  northwind: { name: 'Northwind Logistics', slug: 'northwind', plan: 'team', ver: 2, source: 'SELF_SERVICE', status: 'ACTIVE', ps: '2026-10-10', pe: '2026-11-09', used: 412, allow: 750 },
  fernhill: { name: 'Fernhill Studio', slug: 'fernhill', plan: 'starter', ver: 1, source: 'SELF_SERVICE', status: 'PAST_DUE', ps: '2026-09-22', pe: '2026-10-22', grace: '2026-10-29', used: 96, allow: 100 },
  oakridge: { name: 'Oakridge Dental', slug: 'oakridge', plan: 'starter', ver: 2, source: 'SELF_SERVICE', status: 'ACTIVE', ps: '2026-10-05', pe: '2026-11-04', used: 61, allow: 150, ext: true },
  brightline: { name: 'Brightline Retail', slug: 'brightline', plan: 'business', ver: 1, source: 'MANUAL', status: 'ACTIVE', ps: '2026-09-18', pe: '2026-10-17', ended: '2026-10-18', anchor: '2024-10-18', commitEnd: '2026-10-17', contract: 'CT-2024-019', used: 0, allow: 3000 },
  // Suspended = PAST_DUE after its grace (sending stopped 15 Oct).
  quarry: { name: 'Quarry Lane Legal', slug: 'quarry-lane', plan: 'team', ver: 1, source: 'SELF_SERVICE', status: 'PAST_DUE', ps: '2026-09-08', pe: '2026-10-07', grace: '2026-10-15', used: 500, allow: 500 },
};

const subId = (k: Key): string => B3_TENANTS[k].replace(/a(\d)$/, '5$1');
const contractId = (k: Key): string => B3_TENANTS[k].replace(/a(\d)$/, 'd$1');

function facts(k: Key) {
  const s = T0[k];
  const vid = `${s.plan}-v${String(s.ver)}`;
  return {
    subscription_id: subId(k),
    product_key: 'sign',
    plan: { id: s.plan, key: `aramo-sign-${s.plan}-v1`, name: PLAN_NAME[s.plan]!, sales_model: s.plan === 'enterprise' ? 'CONTACT_SALES' : 'SELF_SERVICE' },
    plan_version: { id: vid, version_number: s.ver, status: RETIRED.has(vid) ? 'RETIRED' : 'PUBLISHED' },
    source: s.source,
    status: s.ended ? 'CANCELED' : s.status,
    started_at: day(s.anchor ?? s.ps),
    ended_at: s.ended ? day(s.ended) : null,
    period_anchor: day(s.anchor ?? s.ps),
    current_period: s.ended ? null : { start: day(s.ps), end: plus1(s.pe) },
    current_period_end: s.source === 'SELF_SERVICE' ? plus1(s.pe) : null,
    grace_until: s.grace ? day(s.grace) : null,
    commitment_end: s.commitEnd ? day(s.commitEnd) : null,
    contract: s.contract ? { id: contractId(k), contract_ref: s.contract } : null,
    provider_linked: s.source === 'SELF_SERVICE',
    open_flags: s.recon ? ['governed_subscription_open'] : [],
    active_extensions: { count: s.ext ? 1 : 0, exception: s.ext === true },
  };
}

export function workbenchRows(): unknown[] {
  return (Object.keys(T0) as Key[]).map((k) => ({ tenant: { id: B3_TENANTS[k], name: T0[k].name, slug: T0[k].slug }, ...facts(k) }));
}

const NONE = (capability: string) => ({ capability, state: 'NONE', granted_source: null, granted_at: null, granted_by: null, change_request_id: null, revoked_at: null, revoked_by: null, revoke_change_request_id: null });
const ACTIVE = (capability: string, at: string, source = 'PROVISIONING', cr: string | null = null) => ({ ...NONE(capability), state: 'ACTIVE', granted_source: source, granted_at: day(at), change_request_id: cr });

// ccp-data.js T0 entitlements (sign, ats, portal, intelligence).
const ENT: Readonly<Record<Key, Record<string, unknown>>> = {
  halcyon: { sign: ACTIVE('sign', '2025-11-14', 'MIGRATION'), ats: ACTIVE('ats', '2023-12-08'), portal: NONE('portal'), intelligence: NONE('intelligence') },
  atlas: { sign: ACTIVE('sign', '2026-05-01'), ats: NONE('ats'), portal: ACTIVE('portal', '2026-06-10', 'MANUAL', CR_0988), intelligence: NONE('intelligence') },
  meridian: { sign: ACTIVE('sign', '2025-03-15'), ats: NONE('ats'), portal: NONE('portal'), intelligence: NONE('intelligence') },
  northwind: { sign: ACTIVE('sign', '2026-02-02'), ats: ACTIVE('ats', '2026-02-02'), portal: NONE('portal'), intelligence: NONE('intelligence') },
  fernhill: { sign: ACTIVE('sign', '2026-03-22'), ats: NONE('ats'), portal: NONE('portal'), intelligence: NONE('intelligence') },
  oakridge: { sign: ACTIVE('sign', '2026-04-05'), ats: NONE('ats'), portal: NONE('portal'), intelligence: NONE('intelligence') },
  brightline: {
    sign: ACTIVE('sign', '2024-10-18'),
    ats: NONE('ats'),
    portal: { ...ACTIVE('portal', '2025-01-10'), state: 'REVOKED', revoked_at: day('2026-10-02'), revoked_by: 'cc000000-0000-7000-8000-00000000705a', revoke_change_request_id: CR_1032 },
    intelligence: NONE('intelligence'),
  },
  quarry: { sign: ACTIVE('sign', '2025-09-08'), ats: NONE('ats'), portal: NONE('portal'), intelligence: NONE('intelligence') },
};

export interface SubsFixtureOptions {
  /** Meridian's flag without its release request (the "Request reconciliation release…" state). */
  readonly noRelease?: boolean;
  /** The workbench answers with no rows (the design's demoState `empty`). */
  readonly empty?: boolean;
  /** The workbench read never answers (the loading skeleton). */
  readonly loading?: boolean;
}

function commercial(k: Key, o: SubsFixtureOptions) {
  const s = T0[k];
  const release = s.recon && !o.noRelease;
  return {
    as_of: SUBS_NOW,
    tenant: { id: B3_TENANTS[k], name: s.name, slug: s.slug, kind: 'BUSINESS' },
    products: [
      {
        product_key: 'sign',
        registered: true,
        entitlement: ENT[k]['sign'],
        subscription: facts(k),
        flags: s.recon
          ? [{ id: 'cb300000-0000-7000-8000-0000000000f3', reason: 'governed_subscription_open', provider: 'STRIPE', subscription_ref: 'sub_1Q9meridianHeld', intent_id: 'cb300000-0000-7000-8000-0000000000e3', detected_at: '2026-10-21T09:12:00.000Z', conversion: release ? { change_request_id: CR_1051, state: 'APPLYING', direction: 'TO_GOVERNED' } : null }]
          : [],
        open_request: release
          ? { id: CR_1051, action_type: 'CONVERSION', kind: 'NORMAL', state: 'APPLYING', requested_by: 'cc000000-0000-7000-8000-00000000705a', created_at: '2026-10-23T12:00:00.000Z' }
          : k === 'northwind'
            ? { id: CR_1042, action_type: 'CREDIT', kind: 'NORMAL', state: 'PENDING_APPROVAL', requested_by: 'cc000000-0000-7000-8000-00000000705a', created_at: '2026-10-24T10:00:00.000Z' }
            : null,
      },
      ...(['ats', 'portal', 'intelligence'] as const).map((p) => ({ product_key: p, registered: false, entitlement: ENT[k][p], subscription: null, flags: [], open_request: null })),
    ],
  };
}

const CLAUSE = { support_extension_max_days: 14, support_extension_frequency_window_days: 90, support_extension_cumulative_max_days: 30, support_extension_cumulative_window_days: 365 };
const POLICY = { version_id: POLICY_V1, version_number: 1, clause: CLAUSE, approval_expiry_hours: 72 };

function supportList(k: Key) {
  const s = T0[k];
  return { extensions: [], subscriptions: s.ended ? [] : [{ id: subId(k), product_key: 'sign', source: s.source, status: s.status, grace_until: s.grace ? day(s.grace) : null, current_period_end: plus1(s.pe) }], policy: POLICY };
}

function signRead(k: Key) {
  const s = T0[k];
  return {
    tenant_id: B3_TENANTS[k],
    tenant_kind: 'BUSINESS',
    capabilities: ['core', 'sign'],
    sign_entitled: true,
    subscription: null,
    allowance: s.ended ? { subscribed: false, state: 'NOT_SUBSCRIBED' } : { subscribed: true, limit: s.allow, used: s.used, remaining: s.allow - s.used, period_start: day(s.ps), period_end: plus1(s.pe) },
    storage: null,
    billing_available: false,
    billing_events: [],
  };
}

function tenantDetail(k: Key) {
  const s = T0[k];
  return {
    tenant: { id: B3_TENANTS[k], name: s.name, kind: 'BUSINESS', slug: s.slug, status: 'ACTIVE', status_reason_code: null, status_changed_at: '2026-03-22T10:00:00.000Z', is_active: true, identity_provider: 'microsoft', created_at: '2026-03-22T10:00:00.000Z', updated_at: '2026-10-20T10:00:00.000Z', activated_at: '2026-03-22T10:00:00.000Z', suspended_at: null },
  };
}

const json = (body: unknown, status = 200) => ({ status, body });
const keyOf = (path: string): Key | undefined => (Object.keys(B3_TENANTS) as Key[]).find((k) => path.includes(B3_TENANTS[k]));

const CR_1051_READ = {
  request: { id: CR_1051, action_type: 'CONVERSION', kind: 'NORMAL', state: 'APPLYING', tenant_id: B3_TENANTS.meridian, product_key: 'sign', payload: { direction: 'TO_GOVERNED', held_subscription_ref: 'sub_1Q9meridianHeld', governed_subscription_id: subId('meridian') }, requested_by: 'cc000000-0000-7000-8000-00000000705a', reason: 'Release the blocked checkout', created_at: '2026-10-23T12:00:00.000Z' },
  approvals: [],
  is_expired: false,
  chain_satisfiable: null,
  steps: [],
  apply_actionable: false,
};

/** The mock options for a persona on the B3 screens. */
export function subsMock(persona: Persona = 'ccpOps', o: SubsFixtureOptions = {}): MockOptions & { clock: string } {
  const handlers: { method?: string; path: RegExp; reply: Handler }[] = [
    { path: /^\/platform\/commercial\/subscriptions$/, reply: () => (o.loading ? 'hang' : json({ as_of: SUBS_NOW, rows: o.empty ? [] : workbenchRows() })) },
    { path: /^\/platform\/commercial\/tenants\/[^/]+\/commercial$/, reply: ({ path }) => (keyOf(path) ? json(commercial(keyOf(path)!, o)) : undefined) },
    { path: /^\/platform\/commercial\/tenants\/[^/]+\/billing-status$/, reply: () => json({ availability: 'BILLING_UNAVAILABLE', invoices: [] }) },
    { path: /^\/platform\/commercial\/support-extensions$/, reply: ({ query }) => (keyOf(query.get('tenant_id') ?? '') ? json(supportList(keyOf(query.get('tenant_id') ?? '')!)) : undefined) },
    { path: /^\/platform\/commercial\/change-requests\/[^/]+\/conversion$/, reply: () => json({ request: CR_1051_READ.request, conversion: { direction: 'TO_GOVERNED', status: 'PENDING_PROVIDER', pending_provider: true } }) },
    { path: /^\/platform\/commercial\/change-requests\/[^/]+$/, reply: ({ path }) => json(path.endsWith(CR_1042) ? { ...CR_1051_READ, request: { ...CR_1051_READ.request, id: CR_1042, action_type: 'CREDIT', state: 'PENDING_APPROVAL', tenant_id: B3_TENANTS.northwind, payload: {} } } : CR_1051_READ) },
    { path: /^\/platform\/tenants\/[^/]+\/sign$/, reply: ({ path }) => (keyOf(path) ? json(signRead(keyOf(path)!)) : undefined) },
    { path: /^\/platform\/tenants\/[^/]+\/audit$/, reply: ({ path }) => (keyOf(path) ? json({ events: [] }) : undefined) },
    { path: /^\/platform\/tenants\/[^/]+$/, reply: ({ path }) => (keyOf(path) ? json(tenantDetail(keyOf(path)!)) : undefined) },
  ];
  return { persona, overrides: handlers, clock: SUBS_NOW };
}

export const tenantPath = (k: Key): string => `/tenants/${B3_TENANTS[k]}?tab=commercial`;
