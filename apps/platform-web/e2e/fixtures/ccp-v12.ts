// CCP-UI-V12 — the deterministic dataset of the Finance, Usage and Alerts screens for the visual,
// a11y, keyboard and 900px suites: a port of the CCP-UI v1.2 prototype's data (doc/design-reference/
// ccp/CCP-UI-v1_2/ccp-data.js T0 + the v1.1 additions: Lumen Analytics, EXT-0047, HELD, CMDS,
// INBOX, USAGE, ALERT_CFG) into the REAL C6 / C1 / D2 / D1 / D3 read shapes
// (apps/platform-web/src/commercial/{finance,usage,alerts}/*-api.ts), at the prototype's frozen clock
// (NOW = 2026-10-24 14:00 UTC). It builds on the CCP-B3 fixture (tenants, workbench rows).
//
// Fixture notes (no mask unless a state says so): the Finance amount scope is applied per persona as
// the server does (holder = platform:billing:amount:read); the failed command's code is
// PROVIDER_ACCOUNT_NOT_FOUND and the failed inbox event's error names no provider object (the
// prototype's strings carry a word scripts/verify-vocabulary.sh bans); the stalled inbox event is
// not ported (the build lists FAILED events only, DV-V12-14). TEST-ONLY: src/ never imports it.

import { B3_TENANTS, subsMock, workbenchRows } from './ccp-subscriptions';
import type { Handler, MockOptions, Reply } from './mock-api';
import { PERSONAS, type Persona } from './session';

export const V12_NOW = '2026-10-24T14:00:00.000Z';
const NOW = Date.parse(V12_NOW);
const H = 3_600_000;
const ago = (h: number): string => new Date(NOW - h * H).toISOString();
const day = (d: string): string => `${d}T00:00:00.000Z`;
const plus1 = (d: string): string => new Date(Date.parse(day(d)) + 86_400_000).toISOString();

export const V12_TENANTS = { ...B3_TENANTS, lumen: 'cb300000-0000-7000-8000-0000000000a9' } as const;
type Key = keyof typeof V12_TENANTS;
const NAME: Readonly<Record<Key, [string, string]>> = {
  halcyon: ['Halcyon Health', 'halcyon'],
  atlas: ['Atlas Freight', 'atlas-freight'],
  meridian: ['Meridian Partners', 'meridian'],
  northwind: ['Northwind Logistics', 'northwind'],
  fernhill: ['Fernhill Studio', 'fernhill'],
  oakridge: ['Oakridge Dental', 'oakridge'],
  brightline: ['Brightline Retail', 'brightline'],
  quarry: ['Quarry Lane Legal', 'quarry-lane'],
  lumen: ['Lumen Analytics', 'lumen'],
};
const subId = (k: Key): string => V12_TENANTS[k].replace(/a(\d)$/, '5$1');

// ccp-data.js P0 list prices (USD per month); Enterprise is contract-priced.
const PRICE: Readonly<Record<string, number | null>> = { 'starter-1': 1900, 'starter-2': 2400, 'team-1': 4900, 'team-2': 5900, 'business-1': 12900, 'business-2': 13900, 'scale-1': 29900, 'enterprise-1': null };
const PLAN: Readonly<Record<string, string>> = { starter: 'Starter', team: 'Team', business: 'Business', scale: 'Scale', enterprise: 'Enterprise' };

interface Sub {
  readonly k: Key;
  readonly plan: string;
  readonly ver: number;
  readonly source: 'MANUAL' | 'SELF_SERVICE';
  readonly status: 'ACTIVE' | 'PAST_DUE';
  /** The last day of the current period (design `pe`). */
  readonly pe: string;
  readonly commitEnd?: string;
  readonly grace?: string;
  /** Contract-priced (design `priceBasis: 'CONTRACT'`). */
  readonly contract?: boolean;
}

// The open Sign subscriptions (ccp-data.js T0 + Lumen), Brightline (ended) excluded.
const OPEN: readonly Sub[] = [
  { k: 'halcyon', plan: 'enterprise', ver: 1, source: 'MANUAL', status: 'ACTIVE', pe: '2026-11-07', commitEnd: '2026-12-08', contract: true },
  { k: 'atlas', plan: 'business', ver: 2, source: 'MANUAL', status: 'ACTIVE', pe: '2026-10-31', commitEnd: '2027-04-30' },
  { k: 'meridian', plan: 'scale', ver: 1, source: 'MANUAL', status: 'ACTIVE', pe: '2026-11-14', commitEnd: '2027-03-14', contract: true },
  { k: 'northwind', plan: 'team', ver: 2, source: 'SELF_SERVICE', status: 'ACTIVE', pe: '2026-11-09' },
  { k: 'fernhill', plan: 'starter', ver: 1, source: 'SELF_SERVICE', status: 'PAST_DUE', pe: '2026-10-22', grace: '2026-10-29' },
  { k: 'oakridge', plan: 'starter', ver: 2, source: 'SELF_SERVICE', status: 'ACTIVE', pe: '2026-11-04' },
  { k: 'quarry', plan: 'team', ver: 1, source: 'SELF_SERVICE', status: 'PAST_DUE', pe: '2026-10-07', grace: '2026-10-14' },
  { k: 'lumen', plan: 'team', ver: 2, source: 'SELF_SERVICE', status: 'ACTIVE', pe: '2026-11-18' },
];

function priceOf(s: Sub) {
  const p = s.contract === true ? null : (PRICE[`${s.plan}-${String(s.ver)}`] ?? null);
  return {
    list_price: p === null ? null : { amount_minor: p, currency: 'USD', billing_interval: 'MONTH' },
    unpriced_reason: p === null ? 'CONTRACT_PRICED' : null,
    price_source: 'PINNED_PLAN_VERSION',
    plan_version_id: `${s.plan}-v${String(s.ver)}`,
  };
}

const end = (s: Sub): { at: string; kind: 'COMMITMENT_END' | 'PERIOD_END' } => (s.source === 'MANUAL' && s.commitEnd ? { at: day(s.commitEnd), kind: 'COMMITMENT_END' } : { at: day(s.pe), kind: 'PERIOD_END' });
const daysUntil = (iso: string): number => Math.round((Date.parse(iso) - NOW) / 86_400_000);

function renewals(within: number) {
  const items = OPEN.map((s) => ({ s, e: end(s) }))
    .filter(({ e }) => daysUntil(e.at) <= within)
    .sort((a, b) => Date.parse(a.e.at) - Date.parse(b.e.at))
    .map(({ s, e }) => ({
      subscription_id: subId(s.k),
      tenant_id: V12_TENANTS[s.k],
      tenant_name: NAME[s.k][0],
      product_key: 'sign',
      source: s.source,
      status: s.status,
      plan_key: s.plan,
      plan_name: PLAN[s.plan]!,
      version_number: s.ver,
      grandfathered: false,
      renewal_kind: e.kind,
      renewal_at: e.at,
      days_until: daysUntil(e.at),
      lapsed: Date.parse(e.at) <= NOW,
      commitment_months: s.commitEnd ? 12 : null,
      cancel_at_period_end: false,
      cancel_requested_within_commitment: false,
      ...priceOf(s),
    }));
  return { as_of: V12_NOW, within_days: within, currency: 'USD', billing_provider_mode: 'test', tax: { enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' }, items, counts: { items: items.length, lapsed: items.filter((i) => i.lapsed).length, commitment_end: 0, period_end: 0 } };
}

function outstanding(holder: boolean) {
  const amount = holder ? { amount_due: null } : { amount_withheld: 'FINANCE_SCOPE_REQUIRED' };
  const row = (s: Sub, o: Record<string, unknown>) => ({
    subscription_id: subId(s.k),
    tenant_id: V12_TENANTS[s.k],
    tenant_name: NAME[s.k][0],
    product_key: 'sign',
    source: s.source,
    status: s.status,
    plan_key: s.plan,
    version_number: s.ver,
    billing_subscription_ref: `sub_${s.k}`,
    status_since: null,
    grace_until: s.grace ? day(s.grace) : null,
    grace_state: 'IN_GRACE',
    current_period_end: plus1(s.pe),
    amount_due_reason: 'INVOICE_READ_NOT_DELIVERED',
    ...amount,
    ...priceOf(s),
    ...o,
  });
  const fern = OPEN.find((s) => s.k === 'fernhill')!;
  const quarry = OPEN.find((s) => s.k === 'quarry')!;
  // Meridian's held self-service checkout (C-8): an INCOMPLETE Sign Team v2 row behind the Manual row.
  const held = { ...row({ k: 'meridian', plan: 'team', ver: 2, source: 'SELF_SERVICE', status: 'ACTIVE', pe: '2026-11-20' }, {}), subscription_id: 'cb300000-0000-7000-8000-0000000000e3', status: 'INCOMPLETE', grace_until: null, grace_state: 'NO_GRACE_DATE' };
  const items = [row(fern, {}), row(quarry, { grace_state: 'GRACE_ENDED' }), held];
  return { as_of: V12_NOW, currency: 'USD', billing_provider_mode: 'test', tax: { enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' }, items, counts: { items: 3, past_due: 2, incomplete: 1, in_grace: 1, grace_ended: 1, no_grace_date: 1 } };
}

/** The FA-4 due state per tenant (design `dueOf`): past due in grace → due; suspended → overdue. */
const DUE: Partial<Record<Key, [boolean, boolean]>> = { fernhill: [true, false], quarry: [true, true], meridian: [false, false] };

const EXT_0047 = 'cc7e0000-0000-7000-8000-000000000047';

function reconciliation() {
  const lumen = OPEN.find((s) => s.k === 'lumen')!;
  return {
    as_of: V12_NOW,
    currency: 'USD',
    billing_provider_mode: 'test',
    tax: { enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' },
    status: 'EXCEPTIONS',
    subscriptions: [
      {
        subscription_id: subId('lumen'), tenant_id: V12_TENANTS.lumen, tenant_name: NAME.lumen[0], product_key: 'sign', source: 'SELF_SERVICE', status: 'ACTIVE', plan_key: 'team', version_number: 2, version_status: 'PUBLISHED', grandfathered: false,
        billing_subscription_ref: 'sub_lumen', provider_price_ref: 'price_team_v2', entitlement: { expected: ['sign'], present: [], missing: ['sign'] }, open_flag_reasons: [], unconfirmed_command_ids: [], discrepancies: ['ENTITLEMENT_MISSING'], ...priceOf(lumen),
      },
    ],
    entitled_without_subscription: [{ tenant_id: V12_TENANTS.brightline, tenant_name: NAME.brightline[0], product_key: 'sign', capabilities: ['sign'], residual_authority: null, residual_authority_until: null }],
    held_activations: [
      {
        flag_id: 'cb300000-0000-7000-8000-0000000000f3', tenant_id: V12_TENANTS.meridian, tenant_name: NAME.meridian[0], product_key: 'sign', provider: 'STRIPE', subscription_ref: 'sub_1Q8mR2', detected_at: '2026-10-21T09:12:00.000Z',
        intent_id: 'cb300000-0000-7000-8000-0000000000e3', intent_status: 'INCOMPLETE', governed_subscription_id: subId('meridian'), governed_plan_key: 'scale', held_plan_key: 'team',
        held_price: { list_price: { amount_minor: 5900, currency: 'USD', billing_interval: 'MONTH' }, unpriced_reason: null, price_source: 'CURRENT_PUBLISHED_PLAN_VERSION', plan_version_id: 'team-v2' },
        unconfirmed_commands: [{ id: CMD_5521, command_kind: 'SUBSCRIPTION_CANCEL', state: 'PENDING_PROVIDER', change_request_id: CR_1051 }],
        resolution: 'PENDING_PROVIDER',
      },
    ],
    other_open_flags: [],
    counts: { open_subscriptions: 8, by_source: {}, by_status: {}, subscriptions_with_discrepancy: 1, discrepancies: { ENTITLEMENT_MISSING: 1 }, entitled_without_subscription: 1, held_activations: 1, other_open_flags: 0, unconfirmed_commands: 1, failed_commands: 1, failed_inbox_events: 1, unprocessed_inbox_events: 0, exceptions: 5 },
  };
}

const CMD_5521 = 'cb300000-0000-7000-8000-000000005521';
const CMD_5498 = 'cb300000-0000-7000-8000-000000005498';
const CR_1051 = 'cb300000-0000-7000-8000-000000001051';

function command(id: string, o: Record<string, unknown>): Record<string, unknown> {
  return { id, provider: 'stripe', change_request_id: null, self_service_request_id: null, step: 0, idempotency_key: id, product_key: 'sign', target_ref: 'sub_x', params: {}, attempts: 1, next_attempt_at: null, failure: null, last_detail: null, provider_accepted_at: null, confirmed_at: null, confirmation_source: null, confirmation_event_id: null, failed_at: null, created_by: 'system', updated_at: V12_NOW, ...o };
}

function commands(state: string | null, holder: boolean) {
  const all = [
    command(CMD_5521, { command_kind: 'SUBSCRIPTION_CANCEL', tenant_id: V12_TENANTS.meridian, change_request_id: CR_1051, state: 'PENDING_PROVIDER', pending_provider: true, provider_accepted_at: ago(30), created_at: ago(30) }),
    command(CMD_5498, {
      command_kind: 'CREDIT_GRANT', tenant_id: V12_TENANTS.northwind, state: 'FAILED', pending_provider: true, attempts: 3, created_at: ago(52), failed_at: ago(50),
      params: holder ? { amount_minor: 12000, currency: 'USD' } : { currency: 'USD', amount_withheld: 'FINANCE_SCOPE_REQUIRED' },
      failure: holder ? { code: 'PROVIDER_ACCOUNT_NOT_FOUND', detail: 'No provider account for the tenant' } : { code: 'PROVIDER_ACCOUNT_NOT_FOUND', detail_withheld: 'FINANCE_SCOPE_REQUIRED' },
    }),
  ];
  return { commands: state === null ? all : all.filter((c) => c.state === state), next_cursor: null };
}

function inbox(status: string | null) {
  const ev = { id: 'cb300000-0000-7000-8000-00000000e401', provider: 'stripe', provider_event_id: 'evt_1Q9xT4', event_type: 'invoice.payment_failed', event_created_at: ago(30), subscription_ref: 'sub_fernhill', checkout_session_ref: null, product_key: 'sign', status: 'FAILED', attempts: 5, next_attempt_at: null, outcome: null, detail: null, last_error: 'No tenant mapped to the provider account', received_at: ago(30), processed_at: null };
  return { events: status === null || status === 'FAILED' ? [ev] : [], next_cursor: null };
}

function revenue(holder: boolean) {
  const bucket = (month: string, events: number, unpriced: number, minor: number) => ({ month, commitment_end: 0, period_end: events, events, priced_events: events - unpriced, unpriced_events: unpriced, ...(holder ? { mrr_minor: minor } : { amount_withheld: 'FINANCE_SCOPE_REQUIRED' }) });
  return {
    as_of: V12_NOW,
    currency: 'USD',
    billing_interval: 'MONTH',
    basis: 'OPEN_SUBSCRIPTIONS_X_PINNED_LIST_PRICE',
    billing_provider_mode: 'test',
    tax: { enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' },
    ...(holder ? { mrr_minor: 30000, arr_minor: 360000 } : { amount_withheld: 'FINANCE_SCOPE_REQUIRED' }),
    by_product: [{ product_key: 'sign', subscriptions: 8, ...(holder ? { mrr_minor: 30000, arr_minor: 360000 } : { amount_withheld: 'FINANCE_SCOPE_REQUIRED' }) }],
    counts: { open_commercial_subscriptions: 8, included: 5, excluded: 3, excluded_by_reason: { CONTRACT_PRICED: 2, STATUS_NOT_REVENUE_BEARING: 1 }, not_commercial_by_source: {} },
    renewal_pipeline: {
      months: 6,
      from_month: '2026-10',
      through_month: '2027-03',
      lapsed: bucket('LAPSED', 2, 0, 0),
      by_month: [bucket('2026-10', 0, 0, 0), bucket('2026-11', 3, 0, 14200), bucket('2026-12', 1, 1, 0), bucket('2027-01', 0, 0, 0), bucket('2027-02', 0, 0, 0), bucket('2027-03', 1, 1, 0)],
    },
  };
}

// ccp-data.js USAGE (tenant, period start, last day, sent, historical, reserved, allowance, aligned).
const USAGE: readonly [Key, string, string, number, number, number, number, boolean][] = [
  ['halcyon', '2026-10-08', '2026-11-07', 18240, 0, 120, 25000, true],
  ['halcyon', '2026-09-08', '2026-10-07', 22110, 1400, 0, 25000, false],
  ['atlas', '2026-10-01', '2026-10-31', 2140, 0, 35, 3000, true],
  ['atlas', '2026-09-01', '2026-09-30', 2788, 0, 0, 3000, true],
  ['meridian', '2026-10-15', '2026-11-14', 4410, 0, 60, 10000, true],
  ['meridian', '2026-09-15', '2026-10-14', 6120, 0, 0, 10000, true],
  ['northwind', '2026-10-10', '2026-11-09', 412, 0, 8, 750, true],
  ['northwind', '2026-09-10', '2026-10-09', 690, 0, 0, 750, true],
  ['fernhill', '2026-09-22', '2026-10-21', 96, 0, 0, 100, true],
  ['fernhill', '2026-08-22', '2026-09-21', 100, 0, 0, 100, true],
  ['oakridge', '2026-10-05', '2026-11-04', 61, 0, 3, 150, true],
  ['oakridge', '2026-09-05', '2026-10-04', 88, 0, 0, 100, false],
  ['brightline', '2026-09-18', '2026-10-17', 1940, 0, 0, 3000, true],
  ['quarry', '2026-09-08', '2026-10-07', 500, 0, 0, 500, true],
  ['lumen', '2026-10-19', '2026-11-18', 38, 0, 4, 750, true],
];

export type UsageState = 'reconciled' | 'pending' | 'notReconciled';

function usageRecon(s: UsageState) {
  const status = s === 'notReconciled' ? 'NOT_RECONCILED' : 'RECONCILED';
  return {
    product_key: 'sign',
    status,
    checked_at: V12_NOW,
    metrics: [{ metric_key: 'sign.envelopes', product_key: 'sign', status, watermark: ago(2), last_run_id: 'run-1', buckets: { source: 15, rollup: 15, pending: s === 'pending' ? 2 : 0, compared: 15, mismatched: s === 'notReconciled' ? 3 : 0 }, compared_totals: {}, usage_event: {}, mismatch_count: s === 'notReconciled' ? 3 : 0, mismatches: [] }],
  };
}

function usagePeriods() {
  return {
    product_key: 'sign',
    reconciliation: { status: 'RECONCILED', checked_at: V12_NOW },
    truncated: false,
    periods: USAGE.map(([k, ps, pe, sent, hist, reserved, allow, aligned]) => ({
      tenant_id: V12_TENANTS[k], metric_key: 'sign.envelopes', product_key: 'sign', period_start: day(ps), period_end: plus1(pe), alignment: aligned ? 'ALIGNED' : 'UNALIGNED', subscription_id: subId(k), plan_version_id: null, included_quantity: allow, unlimited: false,
      counts: { consumed: sent + hist, consumed_send: sent, consumed_historical: hist, reserved }, stale: false, computed_at: ago(2),
    })),
  };
}

// ccp-data.js `ald` (Commercial Control Plane v1.2.dc.html :1084-1096), as D3 alerts.
const CR = (n: number): string => `cb300000-0000-7000-8000-00000000${String(n).padStart(4, '0')}`;
function alert(n: number, o: Record<string, unknown>) {
  return { id: `cb300000-0000-7000-8000-0000000a${String(n).padStart(4, '0')}`, family: 'BILLING', tenant_id: null, product_key: 'sign', threshold_minutes: null, detection_count: 1, last_detected_at: V12_NOW, resolved_at: null, resolution_detail: null, evidence: {}, ...o };
}
function alerts(usage: UsageState) {
  const billing = [
    alert(415, { alert_type: 'COMMAND_PENDING_PROVIDER_STUCK', subject_kind: 'billing_command', subject_id: CMD_5521, tenant_id: V12_TENANTS.meridian, status: 'OPEN', detail: 'Pending 30 h; threshold 24 h.', first_detected_at: ago(6), threshold_minutes: 1440, evidence: { command_kind: 'SUBSCRIPTION_CANCEL', change_request_id: CR_1051 } }),
    alert(414, { alert_type: 'COMMAND_FAILED', subject_kind: 'billing_command', subject_id: CMD_5498, tenant_id: V12_TENANTS.northwind, status: 'OPEN', detail: 'Account credit not applied: PROVIDER_ACCOUNT_NOT_FOUND.', first_detected_at: ago(52), evidence: { command_kind: 'CREDIT_GRANT', change_request_id: null } }),
    alert(416, { alert_type: 'HELD_ACTIVATION', subject_kind: 'reconciliation_flag', subject_id: 'cb300000-0000-7000-8000-0000000000f3', tenant_id: V12_TENANTS.meridian, status: 'OPEN', detail: 'Self-service checkout held behind the Manual contract CT-2025-014.', first_detected_at: '2026-10-21T09:12:00.000Z' }),
    alert(413, { alert_type: 'WEBHOOK_INBOX_FAILED', subject_kind: 'webhook_inbox', subject_id: 'cb300000-0000-7000-8000-00000000e401', tenant_id: V12_TENANTS.fernhill, status: 'OPEN', detail: 'invoice.payment_failed failed 5 times: no tenant mapped to the provider account.', first_detected_at: ago(30), evidence: { provider_event_id: 'evt_1Q9xT4' } }),
    alert(420, { alert_type: 'USAGE_NOT_RECONCILED', subject_kind: 'usage_metric', subject_id: 'sign.envelopes', status: usage === 'notReconciled' ? 'OPEN' : 'RESOLVED', detail: '3 mismatches in the last incremental run.', first_detected_at: ago(2), resolution_detail: usage === 'pending' ? 'Reconciliation pending' : 'Reconciled' }),
  ];
  const approvals = [
    alert(421, { family: 'APPROVAL', alert_type: 'APPLY_FAILED', subject_kind: 'change_request', subject_id: CR(1053), status: 'OPEN', product_key: null, detail: 'Activation timed out (POLICY_ACTIVATION_TIMEOUT). The requester can retry or withdraw.', first_detected_at: ago(15), evidence: { action_type: 'POLICY_ACTIVATE' } }),
    alert(417, { family: 'APPROVAL', alert_type: 'APPLY_FAILED', subject_kind: 'change_request', subject_id: CR(1046), tenant_id: V12_TENANTS.brightline, status: 'OPEN', detail: 'Entitlement revoke timed out (ENTITLEMENT_REVOKE_TIMEOUT).', first_detected_at: ago(20), evidence: { action_type: 'SUBSCRIPTION_END' } }),
    alert(409, { family: 'APPROVAL', alert_type: 'APPLY_DEADLINE_PASSED', subject_kind: 'change_request', subject_id: CR(1055), tenant_id: V12_TENANTS.oakridge, status: 'RESOLVED', detail: '', first_detected_at: ago(36), resolution_detail: 'Apply expired', evidence: { action_type: 'ENTITLEMENT_GRANT' } }),
    alert(401, { family: 'APPROVAL', alert_type: 'APPROVAL_PAST_EXPIRY', subject_kind: 'change_request', subject_id: CR(1047), tenant_id: V12_TENANTS.meridian, status: 'RESOLVED', detail: '', first_detected_at: ago(60), resolution_detail: 'Expired', evidence: { action_type: 'DISCOUNT' } }),
  ];
  return { billing, approvals };
}

const METRICS = (kind: 'billing' | 'approvals') => ({
  as_of: V12_NOW,
  ...(kind === 'billing'
    ? { commands_by_state: { PENDING_PROVIDER: 1, FAILED: 1 }, commands_pending_provider_past_threshold: 1, webhook_inbox_by_status: { FAILED: 1 }, open_reconciliation_flags_by_reason: { governed_subscription_open: 1 } }
    : { change_requests_by_state: {}, pending_approval_nearing_expiry: 0, pending_approval_past_expiry: 0 }),
  open_alerts_by_type: {},
  thresholds: { pending_provider_stuck_minutes: 1440, approval_expiry_lead_minutes: 720 },
});

const json = (body: unknown, status = 200): Reply => ({ status, body });

export interface V12Options {
  /** Every read answers empty (the design's demoState "empty"). */
  readonly empty?: boolean;
  /** The screen's main read never answers (the design's demoState "loading"). */
  readonly loading?: boolean;
  readonly usage?: UsageState;
}

/** The mock options for a persona on the v1.2 screens (on top of the CCP-B3 dataset). */
export function v12Mock(persona: Persona, o: V12Options = {}): MockOptions & { clock: string } {
  const holder = (PERSONAS[persona].scopes as readonly string[]).includes('platform:billing:amount:read');
  const hang = (r: () => Reply): Handler => () => (o.loading ? 'hang' : r());
  const handlers: { method?: string; path: RegExp; reply: Handler }[] = [
    {
      path: /^\/platform\/tenants$/,
      reply: () =>
        json({ tenants: (Object.keys(V12_TENANTS) as Key[]).map((k) => ({ id: V12_TENANTS[k], name: NAME[k][0], kind: 'BUSINESS', slug: NAME[k][1], status: 'ACTIVE', status_reason_code: null, status_changed_at: '2026-01-01T00:00:00Z', is_active: true, created_at: '2026-01-01T00:00:00Z', activated_at: '2026-01-01T00:00:00Z', suspended_at: null })) }),
    },
    {
      path: /^\/platform\/commercial\/subscriptions$/,
      reply: () =>
        json({
          as_of: V12_NOW,
          rows: [
            ...workbenchRows(),
            { tenant: { id: V12_TENANTS.lumen, name: NAME.lumen[0], slug: NAME.lumen[1] }, subscription_id: subId('lumen'), product_key: 'sign', plan: { id: 'team', key: 'aramo-sign-team-v1', name: 'Team', sales_model: 'SELF_SERVICE' }, plan_version: { id: 'team-v2', version_number: 2, status: 'PUBLISHED' }, source: 'SELF_SERVICE', status: 'ACTIVE', started_at: day('2026-10-19'), ended_at: null, period_anchor: day('2026-10-19'), current_period: { start: day('2026-10-19'), end: plus1('2026-11-18') }, current_period_end: plus1('2026-11-18'), grace_until: null, commitment_end: null, contract: null, provider_linked: true, open_flags: [], active_extensions: { count: 0, exception: false } },
          ],
        }),
    },
    { path: /^\/platform\/commercial\/finance\/renewals$/, reply: ({ query }) => (o.loading ? 'hang' : json(o.empty ? { ...renewals(90), items: [] } : renewals(Number(query.get('within_days') ?? 90)))) },
    { path: /^\/platform\/commercial\/finance\/outstanding-payments$/, reply: hang(() => json(o.empty ? { ...outstanding(holder), items: [] } : outstanding(holder))) },
    { path: /^\/platform\/commercial\/finance\/reconciliation-report$/, reply: hang(() => json(o.empty ? { ...reconciliation(), status: 'RECONCILED', subscriptions: [], entitled_without_subscription: [], held_activations: [], counts: { ...reconciliation().counts, exceptions: 0 } } : reconciliation())) },
    { path: /^\/platform\/commercial\/finance\/revenue$/, reply: hang(() => json(o.empty ? { ...revenue(holder), counts: { ...revenue(holder).counts, open_commercial_subscriptions: 0 } } : revenue(holder))) },
    { path: /^\/platform\/commercial\/billing-commands$/, reply: ({ query }) => json(o.empty ? { commands: [], next_cursor: null } : commands(query.get('state'), holder)) },
    { path: /^\/platform\/commercial\/billing-webhook-inbox$/, reply: ({ query }) => json(o.empty ? { events: [], next_cursor: null } : inbox(query.get('status'))) },
    { path: /^\/platform\/commercial\/metrics\/billing$/, reply: () => json(METRICS('billing')) },
    { path: /^\/platform\/commercial\/metrics\/approvals$/, reply: () => json(METRICS('approvals')) },
    { path: /^\/platform\/commercial\/usage\/reconciliation$/, reply: hang(() => json(usageRecon(o.usage ?? 'reconciled'))) },
    { path: /^\/platform\/commercial\/usage\/periods$/, reply: () => (o.usage === 'notReconciled' ? json({ error: { code: 'USAGE_ROLLUP_NOT_RECONCILED', message: 'not reconciled' } }, 409) : json(o.empty ? { ...usagePeriods(), periods: [] } : usagePeriods())) },
    { path: /^\/platform\/commercial\/alerts\/billing$/, reply: hang(() => json({ alerts: o.empty ? [] : alerts(o.usage ?? 'reconciled').billing, next_cursor: null })) },
    { path: /^\/platform\/commercial\/alerts\/approvals$/, reply: hang(() => json({ alerts: o.empty ? [] : alerts(o.usage ?? 'reconciled').approvals, next_cursor: null })) },
    {
      path: /^\/platform\/commercial\/tenants\/[^/]+\/billing-status$/,
      reply: ({ path }) => {
        const k = (Object.keys(V12_TENANTS) as Key[]).find((x) => path.includes(V12_TENANTS[x]));
        const d = k === undefined ? undefined : DUE[k];
        if (d === undefined) return json({ availability: 'BILLING_UNAVAILABLE', payment_due: false, payment_overdue: false, tax: { enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' } });
        return json({ availability: 'AVAILABLE', payment_due: d[0], payment_overdue: d[1], tax: { enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' }, ...(holder ? { invoices: [] } : { amount_withheld: 'FINANCE_SCOPE_REQUIRED' }) });
      },
    },
    {
      path: /^\/platform\/commercial\/support-extensions$/,
      reply: ({ query }) =>
        query.get('tenant_id') === V12_TENANTS.fernhill
          ? json({
              extensions: [{ id: EXT_0047, tenant_id: V12_TENANTS.fernhill, product_key: 'sign', subscription_id: subId('fernhill'), change_request_id: 'cc7e0000-0000-7000-8000-000000000c47', is_exception: true, days: 7, grace_until_at_apply: day('2026-10-29'), base_until: day('2026-10-29'), extends_until: day('2026-11-05'), policy_version_id: 'p1', applied_by: PERSONAS.ccpSupport.sub, applied_at: '2026-10-20T11:05:00.000Z', removed_at: null, removed_by: null, remove_change_request_id: null, active: true }],
              subscriptions: [],
              policy: null,
            })
          : undefined,
    },
  ];
  const base = subsMock(persona);
  return { persona, clock: V12_NOW, overrides: [...handlers, ...(base.overrides ?? [])] };
}
