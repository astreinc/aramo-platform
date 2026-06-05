import { describe, expect, it } from 'vitest';

import { validateCompensationInput } from '../lib/compensation-validation.js';

// Compensation-Field Modeling v1.1 — closed-set guards at the
// controller boundary (v1.0 §2.3 carried into v1.1). VALIDATION_ERROR
// on miss; ISO-4217 currency, the comp-model and rate-period enums,
// and decimal-string shape are all closed-set guarded. Proof 14
// adjunct: a CONTRACT requisition is permitted to also carry
// placement_fee fields — the application doesn't enforce the
// discriminator gate at validation time (the discriminator is a
// LABEL, not an exclusion constraint).

const REQUEST_ID = 'req-test-1';

describe('compensation-validation — validateCompensationInput', () => {
  it('empty input passes', () => {
    expect(() => validateCompensationInput({}, REQUEST_ID)).not.toThrow();
  });

  it('the PO worked-example input passes', () => {
    expect(() =>
      validateCompensationInput(
        {
          compensation_model: 'CONTRACT',
          pay_rate_amount: '60.00',
          pay_rate_currency: 'USD',
          pay_rate_period: 'HOURLY',
          bill_rate_amount: '80.00',
          bill_rate_currency: 'USD',
          bill_rate_period: 'HOURLY',
        },
        REQUEST_ID,
      ),
    ).not.toThrow();
  });

  it('PERMANENT input with placement_fee + structured salary passes', () => {
    expect(() =>
      validateCompensationInput(
        {
          compensation_model: 'PERMANENT',
          placement_fee_percent: '20.00',
          placement_fee_amount: '15000.00',
          salary_amount: '120000.00',
          salary_currency: 'USD',
        },
        REQUEST_ID,
      ),
    ).not.toThrow();
  });

  describe('ISO-4217 closed-set guard', () => {
    it('rejects a non-ISO currency code', () => {
      expect(() =>
        validateCompensationInput({ pay_rate_currency: 'XYZ' }, REQUEST_ID),
      ).toThrow(/pay_rate_currency/);
    });

    it('rejects a lowercase currency code (the API contract is uppercase)', () => {
      expect(() =>
        validateCompensationInput({ bill_rate_currency: 'usd' }, REQUEST_ID),
      ).toThrow(/bill_rate_currency/);
    });

    it('accepts common ISO codes', () => {
      for (const ccy of ['USD', 'EUR', 'GBP', 'INR', 'AUD']) {
        expect(() =>
          validateCompensationInput({ salary_currency: ccy }, REQUEST_ID),
        ).not.toThrow();
      }
    });
  });

  describe('comp-model closed-set guard', () => {
    it('rejects an unknown compensation_model', () => {
      expect(() =>
        validateCompensationInput(
          { compensation_model: 'TEMP' },
          REQUEST_ID,
        ),
      ).toThrow(/compensation_model/);
    });

    it('accepts CONTRACT and PERMANENT', () => {
      expect(() =>
        validateCompensationInput({ compensation_model: 'CONTRACT' }, REQUEST_ID),
      ).not.toThrow();
      expect(() =>
        validateCompensationInput({ compensation_model: 'PERMANENT' }, REQUEST_ID),
      ).not.toThrow();
    });
  });

  describe('RatePeriod closed-set guard', () => {
    it('rejects an unknown rate period', () => {
      expect(() =>
        validateCompensationInput({ pay_rate_period: 'FORTNIGHTLY' }, REQUEST_ID),
      ).toThrow(/pay_rate_period/);
    });

    it('accepts all five canonical periods', () => {
      for (const period of ['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'ANNUAL']) {
        expect(() =>
          validateCompensationInput({ bill_rate_period: period }, REQUEST_ID),
        ).not.toThrow();
      }
    });
  });

  describe('decimal-string shape guard', () => {
    it('rejects a non-decimal string', () => {
      expect(() =>
        validateCompensationInput({ pay_rate_amount: 'abc' }, REQUEST_ID),
      ).toThrow(/pay_rate_amount/);
    });

    it('rejects scientific notation', () => {
      expect(() =>
        validateCompensationInput({ salary_amount: '1e5' }, REQUEST_ID),
      ).toThrow(/salary_amount/);
    });

    it('rejects negative amounts', () => {
      expect(() =>
        validateCompensationInput({ placement_fee_amount: '-100' }, REQUEST_ID),
      ).toThrow(/placement_fee_amount/);
    });

    it('accepts integer and fractional decimal strings', () => {
      expect(() =>
        validateCompensationInput({ pay_rate_amount: '60' }, REQUEST_ID),
      ).not.toThrow();
      expect(() =>
        validateCompensationInput({ bill_rate_amount: '80.50' }, REQUEST_ID),
      ).not.toThrow();
    });
  });

  describe('proof 14 adjunct — discriminator is a LABEL not a gate', () => {
    it('CONTRACT input that also carries perm fields passes validation', () => {
      // The application doesn't reject mixed-shape inputs at the
      // validator. Reporting / display layers consume compensation_model
      // to decide which fields are MEANINGFUL — but the data layer
      // permits both sets to coexist.
      expect(() =>
        validateCompensationInput(
          {
            compensation_model: 'CONTRACT',
            pay_rate_amount: '60.00',
            pay_rate_currency: 'USD',
            pay_rate_period: 'HOURLY',
            bill_rate_amount: '80.00',
            bill_rate_currency: 'USD',
            bill_rate_period: 'HOURLY',
            placement_fee_percent: '20.00',
          },
          REQUEST_ID,
        ),
      ).not.toThrow();
    });
  });
});
