import { describe, expect, it } from 'vitest';

import { listPriceCell, mismatchRows, withheldCount, withheldLine } from './finance-model';
import type { ReconciledSubscription } from './finance-api';

// Amendment M-A12-A2 R-4 — an app-store test purchase (Apple sandbox, Google Play test purchase) is
// never revenue, so the Withheld tile does not count it as withheld, as it does not count a row
// excluded only for its status.
describe('Withheld tile and app-store test purchases (M-A12-A2)', () => {
  const byReason = { STORE_TEST_PURCHASE: 2, STATUS_NOT_REVENUE_BEARING: 3, CONTRACT_PRICED: 1, NON_USD_CURRENCY: 1 };

  it('withheldCount leaves out test purchases and status-only exclusions', () => {
    expect(withheldCount(byReason)).toBe(2);
  });

  it('withheldLine names only real withheld reasons', () => {
    expect(withheldLine(byReason)).toBe('1 contract-priced, 1 non-USD');
    expect(withheldLine({ STORE_TEST_PURCHASE: 4, STATUS_NOT_REVENUE_BEARING: 1 })).toBe('None');
  });
});

// CCP-PERSONAL-ARRANGED-1 P-3 — a COMP row is "Comp ($0)" in the finance views, never its list price.
describe('Comp rows in the finance views (CCP-PERSONAL-ARRANGED-1 P-3)', () => {
  it('CPA-F-1 listPriceCell: ARRANGEMENT_COMP reads "Comp ($0)"; a pinned list price is unchanged', () => {
    expect(listPriceCell({ list_price: { amount_minor: 0, currency: 'USD', billing_interval: 'MONTH' }, unpriced_reason: null, price_source: 'ARRANGEMENT_COMP', plan_version_id: 'pv' })).toEqual({ kind: 'price', text: 'Comp ($0)', sub: 'Arranged by Aramo · no charge' });
    expect(listPriceCell({ list_price: { amount_minor: 1000, currency: 'USD', billing_interval: 'MONTH' }, unpriced_reason: null, price_source: 'PINNED_PLAN_VERSION', plan_version_id: 'pv' })).toMatchObject({ kind: 'price', text: '$10 / month' });
  });

  it('CPA-F-2 a reconciliation row names a COMP subscription as Comp ($0)', () => {
    const sub = {
      subscription_id: 's', tenant_id: 't', tenant_name: 'Rowan Ellis', product_key: 'sign', source: 'MANUAL', status: 'ACTIVE', plan_key: 'aramo-sign-standard-personal-v1',
      version_number: 1, version_status: 'PUBLISHED', grandfathered: false, billing_subscription_ref: null, provider_price_ref: null,
      entitlement: { expected: ['sign'], present: [], missing: ['sign'] }, open_flag_reasons: [], unconfirmed_command_ids: [], discrepancies: ['ENTITLEMENT_MISSING'],
      arrangement: 'COMP', list_price: { amount_minor: 0, currency: 'USD', billing_interval: 'MONTH' }, unpriced_reason: null, price_source: 'ARRANGEMENT_COMP', plan_version_id: 'pv',
    } satisfies ReconciledSubscription;
    expect(mismatchRows([sub], [], new Date('2026-11-23T00:00:00Z'))[0]!.subscription).toContain('· Comp ($0) ·');
  });
});
