import { describe, expect, it } from 'vitest';

import {
  COMPENSATION_FIELD_KEYS,
  COMPENSATION_VIEW_BILL,
  COMPENSATION_VIEW_MARGIN_PERCENT,
  COMPENSATION_VIEW_PAY,
  COMPENSATION_VIEW_REVENUE,
  COMPENSATION_VIEW_SPREAD_AMOUNT,
  COMPENSATION_VIEW_SPREAD_PERCENT,
  assertNonInvertibleBundle,
  omitMaskedCompensationFields,
  visibleCompensationFields,
} from '../index.js';

// AUTHZ-D5 — libs/field-masking unit tests.
//
// The catalog-level seeded-bundle proof lives in
// libs/identity/src/tests/d5-non-invertibility.spec.ts (it walks the
// seeded D5_COMPENSATION_BUNDLES and asserts the enforced invariant
// across every role). These tests prove the FUNCTIONS in isolation:
// scope→field map, the omit operation, and the invariant validator.

const FULL_VIEW = {
  id: 'req-1',
  title: 'Backend Engineer',
  compensation_model: 'CONTRACT',
  pay_rate_amount: '60.00',
  pay_rate_currency: 'USD',
  pay_rate_period: 'HOURLY',
  bill_rate_amount: '80.00',
  bill_rate_currency: 'USD',
  bill_rate_period: 'HOURLY',
  placement_fee_percent: null,
  placement_fee_amount: null,
  salary_amount: null,
  salary_currency: null,
  margin_amount: '20.00',
  markup_percent: '33.33',
  margin_percent: '25.00',
} as const;

describe('visibleCompensationFields — scope→field expansion', () => {
  it('view:pay grants pay_rate_* + salary_*', () => {
    expect([...visibleCompensationFields([COMPENSATION_VIEW_PAY])].sort()).toEqual([
      'pay_rate_amount',
      'pay_rate_currency',
      'pay_rate_period',
      'salary_amount',
      'salary_currency',
    ]);
  });

  it('view:bill grants bill_rate_* + placement_fee_*', () => {
    expect([...visibleCompensationFields([COMPENSATION_VIEW_BILL])].sort()).toEqual([
      'bill_rate_amount',
      'bill_rate_currency',
      'bill_rate_period',
      'placement_fee_amount',
      'placement_fee_percent',
    ]);
  });

  it('view:revenue grants bill_rate_* only (no placement_fee_*)', () => {
    expect([...visibleCompensationFields([COMPENSATION_VIEW_REVENUE])].sort()).toEqual([
      'bill_rate_amount',
      'bill_rate_currency',
      'bill_rate_period',
    ]);
  });

  it('each spread scope grants exactly one derived field (single granularity)', () => {
    expect([...visibleCompensationFields([COMPENSATION_VIEW_SPREAD_AMOUNT])]).toEqual([
      'margin_amount',
    ]);
    expect([...visibleCompensationFields([COMPENSATION_VIEW_SPREAD_PERCENT])]).toEqual([
      'markup_percent',
    ]);
    expect([...visibleCompensationFields([COMPENSATION_VIEW_MARGIN_PERCENT])]).toEqual([
      'margin_percent',
    ]);
  });

  it('multiple scopes union — see-all tier sees every comp field', () => {
    const allScopes = [
      COMPENSATION_VIEW_PAY,
      COMPENSATION_VIEW_BILL,
      COMPENSATION_VIEW_REVENUE,
      COMPENSATION_VIEW_SPREAD_AMOUNT,
      COMPENSATION_VIEW_SPREAD_PERCENT,
      COMPENSATION_VIEW_MARGIN_PERCENT,
    ];
    const visible = visibleCompensationFields(allScopes);
    expect(visible.size).toBe(COMPENSATION_FIELD_KEYS.length);
    for (const k of COMPENSATION_FIELD_KEYS) expect(visible.has(k)).toBe(true);
  });

  it('no comp scopes → no fields visible', () => {
    expect(visibleCompensationFields([]).size).toBe(0);
    expect(visibleCompensationFields(['requisition:read', 'talent:read']).size).toBe(0);
  });

  it('unknown / unrelated scopes are ignored without throwing', () => {
    expect(visibleCompensationFields(['nonsense:scope', 'not:a:scope']).size).toBe(0);
  });
});

describe('omitMaskedCompensationFields — field-OMISSION (not null-out)', () => {
  it('with see-all scopes the view passes through with every comp field present', () => {
    const allScopes = [
      COMPENSATION_VIEW_PAY,
      COMPENSATION_VIEW_BILL,
      COMPENSATION_VIEW_REVENUE,
      COMPENSATION_VIEW_SPREAD_AMOUNT,
      COMPENSATION_VIEW_SPREAD_PERCENT,
      COMPENSATION_VIEW_MARGIN_PERCENT,
    ];
    const out = omitMaskedCompensationFields({ ...FULL_VIEW }, allScopes);
    for (const k of COMPENSATION_FIELD_KEYS) expect(k in out).toBe(true);
  });

  it('with no comp scopes every comp field is OMITTED (key absent, not null)', () => {
    const out = omitMaskedCompensationFields({ ...FULL_VIEW }, []);
    for (const k of COMPENSATION_FIELD_KEYS) {
      expect(k in out).toBe(false);
    }
    // Non-comp fields preserved.
    expect(out.id).toBe('req-1');
    expect(out.title).toBe('Backend Engineer');
    // compensation_model (a discriminator label, not a $ value) preserved.
    expect(out.compensation_model).toBe('CONTRACT');
  });

  it('recruiter (view:pay) sees pay/salary, all spread + bill masked', () => {
    const out = omitMaskedCompensationFields({ ...FULL_VIEW }, [
      COMPENSATION_VIEW_PAY,
    ]);
    expect('pay_rate_amount' in out).toBe(true);
    expect('pay_rate_currency' in out).toBe(true);
    expect('pay_rate_period' in out).toBe(true);
    expect('salary_amount' in out).toBe(true);
    expect('salary_currency' in out).toBe(true);
    // Masked:
    expect('bill_rate_amount' in out).toBe(false);
    expect('bill_rate_currency' in out).toBe(false);
    expect('bill_rate_period' in out).toBe(false);
    expect('placement_fee_amount' in out).toBe(false);
    expect('placement_fee_percent' in out).toBe(false);
    expect('margin_amount' in out).toBe(false);
    expect('markup_percent' in out).toBe(false);
    expect('margin_percent' in out).toBe(false);
  });

  it('account_manager bundle: bill + revenue + spread:percent + margin:percent (no pay, no spread:amount)', () => {
    const out = omitMaskedCompensationFields({ ...FULL_VIEW }, [
      COMPENSATION_VIEW_BILL,
      COMPENSATION_VIEW_REVENUE,
      COMPENSATION_VIEW_SPREAD_PERCENT,
      COMPENSATION_VIEW_MARGIN_PERCENT,
    ]);
    // Visible:
    expect('bill_rate_amount' in out).toBe(true);
    expect('placement_fee_amount' in out).toBe(true);
    expect('markup_percent' in out).toBe(true);
    expect('margin_percent' in out).toBe(true);
    // Masked:
    expect('pay_rate_amount' in out).toBe(false);
    expect('salary_amount' in out).toBe(false);
    expect('margin_amount' in out).toBe(false);
  });

  it('finance bundle: revenue + margin:percent (no pay, no bill-fee, no spread:amount, no markup)', () => {
    const out = omitMaskedCompensationFields({ ...FULL_VIEW }, [
      COMPENSATION_VIEW_REVENUE,
      COMPENSATION_VIEW_MARGIN_PERCENT,
    ]);
    expect('bill_rate_amount' in out).toBe(true);
    expect('margin_percent' in out).toBe(true);
    // No fee (revenue does not grant placement_fee_*):
    expect('placement_fee_amount' in out).toBe(false);
    expect('placement_fee_percent' in out).toBe(false);
    // No pay, no spread amount, no markup:
    expect('pay_rate_amount' in out).toBe(false);
    expect('margin_amount' in out).toBe(false);
    expect('markup_percent' in out).toBe(false);
  });

  it('delivery_manager bundle: revenue + all 3 spread/margin views (no pay)', () => {
    const out = omitMaskedCompensationFields({ ...FULL_VIEW }, [
      COMPENSATION_VIEW_REVENUE,
      COMPENSATION_VIEW_SPREAD_AMOUNT,
      COMPENSATION_VIEW_SPREAD_PERCENT,
      COMPENSATION_VIEW_MARGIN_PERCENT,
    ]);
    expect('bill_rate_amount' in out).toBe(true);
    expect('margin_amount' in out).toBe(true);
    expect('markup_percent' in out).toBe(true);
    expect('margin_percent' in out).toBe(true);
    // No pay, no fee:
    expect('pay_rate_amount' in out).toBe(false);
    expect('salary_amount' in out).toBe(false);
    expect('placement_fee_amount' in out).toBe(false);
  });

  it('omission is clean: JSON.stringify drops the masked keys', () => {
    const out = omitMaskedCompensationFields({ ...FULL_VIEW }, [COMPENSATION_VIEW_PAY]);
    const json = JSON.parse(JSON.stringify(out));
    expect('bill_rate_amount' in json).toBe(false);
    expect('margin_amount' in json).toBe(false);
    // The mask is OMISSION, not null-out (per comp v1.1 §3):
    expect(json.pay_rate_amount).toBe('60.00');
  });

  it('does not mutate the input view (shallow clone)', () => {
    const input = { ...FULL_VIEW };
    const before = JSON.stringify(input);
    omitMaskedCompensationFields(input, [COMPENSATION_VIEW_PAY]);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('assertNonInvertibleBundle — THE ENFORCED INVARIANT', () => {
  it('rejects view:pay + view:spread:amount (margin_amount + pay → bill)', () => {
    expect(() =>
      assertNonInvertibleBundle('test_role', [
        COMPENSATION_VIEW_PAY,
        COMPENSATION_VIEW_SPREAD_AMOUNT,
      ]),
    ).toThrow(/non-invertibility violation.*test_role.*compensation:view:spread:amount/i);
  });

  it('rejects view:pay + view:spread:percent (markup% + pay → bill)', () => {
    expect(() =>
      assertNonInvertibleBundle('test_role', [
        COMPENSATION_VIEW_PAY,
        COMPENSATION_VIEW_SPREAD_PERCENT,
      ]),
    ).toThrow(/compensation:view:spread:percent/);
  });

  it('rejects view:pay + view:margin:percent (margin% + pay → bill)', () => {
    expect(() =>
      assertNonInvertibleBundle('test_role', [
        COMPENSATION_VIEW_PAY,
        COMPENSATION_VIEW_MARGIN_PERCENT,
      ]),
    ).toThrow(/compensation:view:margin:percent/);
  });

  it('rejects view:pay + multiple spread scopes (lists every offender)', () => {
    expect(() =>
      assertNonInvertibleBundle('test_role', [
        COMPENSATION_VIEW_PAY,
        COMPENSATION_VIEW_SPREAD_AMOUNT,
        COMPENSATION_VIEW_SPREAD_PERCENT,
        COMPENSATION_VIEW_MARGIN_PERCENT,
      ]),
    ).toThrow(/spread:amount.*spread:percent.*margin:percent/);
  });

  it('accepts view:pay alone (recruiter / back_office / RM / LR)', () => {
    expect(() =>
      assertNonInvertibleBundle('recruiter', [COMPENSATION_VIEW_PAY]),
    ).not.toThrow();
  });

  it('accepts a spread-only bundle without pay (delivery_manager / finance / AM)', () => {
    expect(() =>
      assertNonInvertibleBundle('account_manager', [
        COMPENSATION_VIEW_BILL,
        COMPENSATION_VIEW_REVENUE,
        COMPENSATION_VIEW_SPREAD_PERCENT,
        COMPENSATION_VIEW_MARGIN_PERCENT,
      ]),
    ).not.toThrow();
  });

  it('accepts the empty bundle (sourcer / auditor default)', () => {
    expect(() => assertNonInvertibleBundle('sourcer', [])).not.toThrow();
  });

  it('accepts the see-all bundle when seeAll: true (TA / TO exemption)', () => {
    expect(() =>
      assertNonInvertibleBundle(
        'tenant_admin',
        [
          COMPENSATION_VIEW_PAY,
          COMPENSATION_VIEW_BILL,
          COMPENSATION_VIEW_REVENUE,
          COMPENSATION_VIEW_SPREAD_AMOUNT,
          COMPENSATION_VIEW_SPREAD_PERCENT,
          COMPENSATION_VIEW_MARGIN_PERCENT,
        ],
        { seeAll: true },
      ),
    ).not.toThrow();
  });

  it('without seeAll the same see-all bundle is rejected (defensive)', () => {
    expect(() =>
      assertNonInvertibleBundle('tenant_admin', [
        COMPENSATION_VIEW_PAY,
        COMPENSATION_VIEW_BILL,
        COMPENSATION_VIEW_SPREAD_AMOUNT,
      ]),
    ).toThrow();
  });
});
