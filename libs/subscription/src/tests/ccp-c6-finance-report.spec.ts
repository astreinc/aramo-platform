import { describe, expect, it } from 'vitest';

import { daysUntil, graceStateAt, priceFigure } from '../lib/billing/billing-finance-report.service.js';
import type { PlanVersionContent } from '../lib/plan-version.js';

// CCP-C6 — unit tests of the pure figure helpers: the ONLY monetary figure is a plan version's USD
// list price; nothing is converted, defaulted or invented.

const terms = (o: Partial<PlanVersionContent['plan']>): PlanVersionContent => ({
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

describe('CCP-C6 figure helpers', () => {
  it('C6-U-1 a USD list price is passed through exactly (minor units, interval)', () => {
    expect(priceFigure(terms({}), 'v1', 'PINNED_PLAN_VERSION')).toEqual({ list_price: { amount_minor: 2000, currency: 'USD', billing_interval: 'MONTH' }, unpriced_reason: null, price_source: 'PINNED_PLAN_VERSION', plan_version_id: 'v1' });
    expect(priceFigure(terms({ list_price_minor: 0, sales_model: 'FREE' }), 'v1', 'PINNED_PLAN_VERSION').list_price).toEqual({ amount_minor: 0, currency: 'USD', billing_interval: 'MONTH' });
  });

  it('C6-U-2 no price is invented: contract-priced, missing, non-USD and unverified versions are withheld with a reason', () => {
    expect(priceFigure(terms({ list_price_minor: null, currency: null, sales_model: 'CONTACT_SALES' }), 'v', 'PINNED_PLAN_VERSION')).toMatchObject({ list_price: null, unpriced_reason: 'CONTRACT_PRICED' });
    expect(priceFigure(terms({ list_price_minor: null, sales_model: 'OPERATOR' }), 'v', 'PINNED_PLAN_VERSION')).toMatchObject({ list_price: null, unpriced_reason: 'NO_LIST_PRICE' });
    expect(priceFigure(terms({ currency: 'EUR' }), 'v', 'PINNED_PLAN_VERSION')).toMatchObject({ list_price: null, unpriced_reason: 'NON_USD_CURRENCY' });
    expect(priceFigure(terms({ currency: null }), 'v', 'PINNED_PLAN_VERSION')).toMatchObject({ list_price: null, unpriced_reason: 'NON_USD_CURRENCY' });
    expect(priceFigure(null, 'v', 'PINNED_PLAN_VERSION')).toMatchObject({ list_price: null, unpriced_reason: 'PLAN_VERSION_INTEGRITY' });
    expect(priceFigure(null, null, 'CURRENT_PUBLISHED_PLAN_VERSION')).toMatchObject({ list_price: null, unpriced_reason: 'NO_LIST_PRICE' });
  });

  it('C6-U-3 days until a renewal round up; a reached instant is 0; a lapsed one is negative', () => {
    const t = new Date('2026-10-26T12:00:00.000Z');
    expect(daysUntil(t, new Date('2026-11-15T12:00:00.000Z'))).toBe(20);
    expect(daysUntil(t, new Date('2026-10-26T13:00:00.000Z'))).toBe(1);
    expect(daysUntil(t, t)).toBe(0);
    expect(Object.is(daysUntil(t, new Date('2026-10-26T11:00:00.000Z')), 0)).toBe(true);
    expect(daysUntil(t, new Date('2026-10-23T12:00:00.000Z'))).toBe(-3);
  });

  it('C6-U-4 grace state derives from grace_until only', () => {
    const t = new Date('2026-10-26T12:00:00.000Z');
    expect(graceStateAt(null, t)).toBe('NO_GRACE_DATE');
    expect(graceStateAt(new Date('2026-10-27T00:00:00.000Z'), t)).toBe('IN_GRACE');
    expect(graceStateAt(t, t)).toBe('GRACE_ENDED');
  });
});
