import { describe, expect, it } from 'vitest';

import { REVENUE_EXCLUSION_REASONS, classifyRevenueRow, computeRevenue, monthKey, type RevenueSourceRow } from '../lib/billing/billing-revenue-report.service.js';
import { planVersionChecksum, type PlanVersionContent } from '../lib/plan-version.js';

// CCP-D2 — unit tests of the pure revenue computation: MRR = Σ pinned USD monthly list prices of the
// open, revenue-bearing commercial rows; ARR = MRR × 12; every other commercial row is excluded with
// exactly one counted reason; the renewal pipeline is grouped by UTC month. Test IDs are cited by
// doc/ccp/slices/CCP-D2-acceptance.md.

const content = (o: Partial<PlanVersionContent['plan']> = {}): PlanVersionContent => ({
  format: 1,
  plan: {
    key: 'k',
    product_key: 'sign',
    name: 'n',
    description: null,
    tenant_kind: 'BUSINESS',
    sales_model: 'SELF_SERVICE',
    list_price_minor: 2000,
    currency: 'USD',
    reference_price_minor: null,
    reference_price_substantiated: false,
    billing_interval: 'MONTH',
    commitment_months: 12,
    eligibility: null,
    support_tier: 'BASIC',
    ...o,
  },
  allowances: [],
  allowance_windows: [],
  capacities: [],
  features: [],
});

let n = 0;
const row = (o: Partial<RevenueSourceRow> & { plan?: Partial<PlanVersionContent['plan']> } = {}): RevenueSourceRow => {
  const c = content(o.plan);
  const id = `00000000-0000-7000-8000-${String(++n).padStart(12, '0')}`;
  return {
    subscription_id: id,
    tenant_id: `t-${n}`,
    product_key: 'sign',
    source: 'MANUAL',
    status: 'ACTIVE',
    plan_key: 'k',
    plan_version_id: `v-${n}`,
    version_number: 1,
    content: c,
    content_checksum: planVersionChecksum(c),
    contract_id: null,
    commitment_end: null,
    current_period_end: null,
    billing_subscription_ref: null,
    ...o,
  };
};

const AS_OF = new Date('2026-10-26T12:00:00.000Z');
const run = (rows: RevenueSourceRow[], months?: number) => computeRevenue(rows, { as_of: AS_OF, months, billing_provider_mode: 'test' });

describe('CCP-D2 revenue computation', () => {
  it('D2-U-1 MRR sums the pinned USD monthly list prices of the included rows exactly; ARR = MRR × 12', () => {
    const r = run([row({ plan: { list_price_minor: 2000 } }), row({ plan: { list_price_minor: 1500 } }), row({ status: 'PAST_DUE', plan: { list_price_minor: 2000 } }), row({ plan: { list_price_minor: 0 } })]);
    expect(r.mrr_minor).toBe(5500);
    expect(r.arr_minor).toBe(66000);
    expect(r.by_product).toEqual([{ product_key: 'sign', subscriptions: 4, mrr_minor: 5500, arr_minor: 66000 }]);
    expect(r.counts).toMatchObject({ open_commercial_subscriptions: 4, included: 4, excluded: 0 });
    expect(r).toMatchObject({ currency: 'USD', billing_interval: 'MONTH', basis: 'OPEN_SUBSCRIPTIONS_X_PINNED_LIST_PRICE' });
  });

  it('D2-U-2 each excluded row carries exactly ONE reason, in precedence order, and every reason is counted (zero-filled)', () => {
    const tampered = row();
    const cases: Array<[RevenueSourceRow, string]> = [
      [row({ status: 'TRIALING' }), 'STATUS_NOT_REVENUE_BEARING'],
      [row({ status: 'INCOMPLETE', plan: { currency: 'EUR' } }), 'STATUS_NOT_REVENUE_BEARING'],
      [row({ status: 'CANCELED' }), 'STATUS_NOT_REVENUE_BEARING'],
      [{ ...tampered, content_checksum: '0'.repeat(64) }, 'PLAN_VERSION_INTEGRITY'],
      [row({ contract_id: 'c-1' }), 'CONTRACT_PRICED'],
      [row({ plan: { list_price_minor: null, sales_model: 'CONTACT_SALES', currency: null, billing_interval: null } }), 'CONTRACT_PRICED'],
      [row({ plan: { list_price_minor: null, sales_model: 'OPERATOR', currency: null } }), 'NO_LIST_PRICE'],
      [row({ plan: { currency: 'EUR' } }), 'NON_USD_CURRENCY'],
      [row({ plan: { currency: null } }), 'NON_USD_CURRENCY'],
      [row({ plan: { billing_interval: null } }), 'NON_MONTHLY_INTERVAL'],
      [row({ plan: { billing_interval: 'YEAR' } }), 'NON_MONTHLY_INTERVAL'],
    ];
    for (const [r, reason] of cases) expect(classifyRevenueRow(r), reason).toEqual({ reason });
    const report = run([...cases.map(([r]) => r), row({ plan: { list_price_minor: 2000 } })]);
    expect(report.mrr_minor).toBe(2000);
    expect(report.counts.excluded).toBe(cases.length);
    expect(Object.keys(report.counts.excluded_by_reason)).toEqual([...REVENUE_EXCLUSION_REASONS]);
    expect(report.counts.excluded_by_reason).toEqual({ STATUS_NOT_REVENUE_BEARING: 3, PLAN_VERSION_INTEGRITY: 1, CONTRACT_PRICED: 2, NO_LIST_PRICE: 1, NON_USD_CURRENCY: 2, NON_MONTHLY_INTERVAL: 2 });
    expect(Object.values(report.counts.excluded_by_reason).reduce((a, b) => a + b, 0)).toBe(report.counts.excluded);
    expect(report.counts.open_commercial_subscriptions).toBe(report.counts.included + report.counts.excluded);
    // A non-USD amount is never converted into the figure, and never shown.
    expect(JSON.stringify(report)).not.toContain('EUR');
  });

  it('D2-U-3 non-commercial sources (FREE, DEVELOPMENT) are neither revenue nor an exclusion; they are counted apart', () => {
    const r = run([row({ source: 'FREE', plan: { list_price_minor: 0 } }), row({ source: 'DEVELOPMENT' }), row({ source: 'DEVELOPMENT' }), row()]);
    expect(r.mrr_minor).toBe(2000);
    expect(r.counts).toMatchObject({ open_commercial_subscriptions: 1, included: 1, excluded: 0, not_commercial_by_source: { DEVELOPMENT: 2, FREE: 1 } });
  });

  it('D2-U-4 the renewal pipeline groups events by UTC month; on or before as_of is LAPSED; beyond the horizon is left out', () => {
    const rows = [
      row({ commitment_end: new Date('2026-10-26T12:00:00.000Z') }), // == as_of → LAPSED
      row({ commitment_end: new Date('2026-10-01T00:00:00.000Z'), plan: { list_price_minor: null, sales_model: 'OPERATOR', currency: null } }), // LAPSED, unpriced
      row({ commitment_end: new Date('2026-10-31T23:59:59.999Z') }), // 2026-10
      row({ commitment_end: new Date('2026-11-01T00:00:00.000Z'), plan: { list_price_minor: 1500 } }), // 2026-11
      row({ source: 'SELF_SERVICE', billing_subscription_ref: 'sub_1', current_period_end: new Date('2026-11-25T00:00:00.000Z'), commitment_end: new Date('2027-01-10T00:00:00.000Z') }), // 2026-11 period + 2027-01 commitment
      row({ current_period_end: new Date('2026-11-20T00:00:00.000Z') }), // not provider-linked → no PERIOD_END
      row({ commitment_end: new Date('2027-01-31T00:00:00.000Z') }), // beyond a 3-month horizon
    ];
    const r = run(rows, 3);
    expect(r.renewal_pipeline).toMatchObject({ months: 3, from_month: '2026-10', through_month: '2026-12' });
    expect(r.renewal_pipeline.lapsed).toEqual({ month: 'LAPSED', commitment_end: 2, period_end: 0, events: 2, priced_events: 1, unpriced_events: 1, mrr_minor: 2000 });
    expect(r.renewal_pipeline.by_month).toEqual([
      { month: '2026-10', commitment_end: 1, period_end: 0, events: 1, priced_events: 1, unpriced_events: 0, mrr_minor: 2000 },
      { month: '2026-11', commitment_end: 1, period_end: 1, events: 2, priced_events: 2, unpriced_events: 0, mrr_minor: 3500 },
      { month: '2026-12', commitment_end: 0, period_end: 0, events: 0, priced_events: 0, unpriced_events: 0, mrr_minor: 0 },
    ]);
    const wide = run(rows, 4);
    expect(wide.renewal_pipeline.by_month.map((b) => [b.month, b.events])).toEqual([['2026-10', 1], ['2026-11', 2], ['2026-12', 0], ['2027-01', 2]]);
    expect(run(rows, 24).renewal_pipeline.through_month).toBe('2028-09');
  });

  it('D2-U-5 the horizon is 1..24 months; a figure past the safe integer range fails closed', () => {
    for (const m of [0, 25, 1.5]) expect(() => run([], m)).toThrow(RangeError);
    expect(run([]).renewal_pipeline.months).toBe(12);
    expect(() => run([row({ plan: { list_price_minor: Number.MAX_SAFE_INTEGER } }), row({ plan: { list_price_minor: 1 } })])).toThrow(/safe integer/);
  });

  it('D2-U-6 monthKey is UTC', () => {
    expect(monthKey(new Date('2026-12-31T23:30:00.000-05:00'))).toBe('2027-01');
    expect(monthKey(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01');
  });
});
