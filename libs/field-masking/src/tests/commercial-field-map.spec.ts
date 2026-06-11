import { describe, expect, it } from 'vitest';

import {
  COMPANY_READ_COMMERCIAL,
  COMPANY_COMMERCIAL_FIELD_KEYS,
  omitMaskedCommercialFields,
} from '../lib/commercial-field-map.js';

// Company-Fields v1.1 — §4 LOAD-BEARING gate 1 (commercial-read-gate).
// The mask is key-DELETE (absent from JSON), NOT key-present-with-null —
// the same contract as the compensation masker.

function makeCompanyView(): Record<string, unknown> {
  return {
    id: 'co-1',
    name: 'Acme',
    status: 'active',
    is_hot: false,
    // the 6 gated commercial fields (present on the projected view)
    fee_model: 'both',
    default_contract_markup_pct: '25.00',
    default_perm_fee_pct: '20.00',
    payment_terms: 'net_30',
    credit_status: 'good',
    default_currency: 'USD',
  };
}

describe('omitMaskedCommercialFields — commercial-read-gate (key-DELETE)', () => {
  it('DELETES all 6 commercial keys for a non-holder (absent from JSON, not null)', () => {
    const masked = omitMaskedCommercialFields(makeCompanyView(), []);
    for (const key of COMPANY_COMMERCIAL_FIELD_KEYS) {
      // key-ABSENT (the contract) — not present-with-null
      expect(key in masked).toBe(false);
      expect(JSON.stringify(masked).includes(key)).toBe(false);
    }
    // Un-gated fields are untouched.
    expect(masked['name']).toBe('Acme');
    expect(masked['status']).toBe('active');
    expect('id' in masked).toBe(true);
  });

  it('keeps every commercial field for a holder of company:read_commercial', () => {
    const masked = omitMaskedCommercialFields(makeCompanyView(), [
      COMPANY_READ_COMMERCIAL,
    ]);
    for (const key of COMPANY_COMMERCIAL_FIELD_KEYS) {
      expect(key in masked).toBe(true);
    }
    expect(masked['default_contract_markup_pct']).toBe('25.00');
  });

  it('does not mutate the input; non-holder result is a distinct shallow clone', () => {
    const input = makeCompanyView();
    const masked = omitMaskedCommercialFields(input, []);
    // original retains its keys
    expect('fee_model' in input).toBe(true);
    expect(masked).not.toBe(input);
  });

  it('an unrelated scope set still hides the fields (only the exact scope unlocks)', () => {
    const masked = omitMaskedCommercialFields(makeCompanyView(), [
      'company:read',
      'company:edit',
      'company:read:all',
    ]);
    expect('fee_model' in masked).toBe(false);
    expect('default_currency' in masked).toBe(false);
  });
});
