import { describe, expect, it } from 'vitest';

import { validateRateType } from '../lib/compensation-validation.js';
import { RATE_TYPE_VALUES, isRateType } from '../lib/dto/rate-type.js';

// Requisition Record Spec Amendment v1.0 — the rate_type closed-set guard
// (String-not-enum, validated at the controller boundary; C2C|W2|1099|Any).

describe('rate_type closed-set guard', () => {
  it('accepts every allowlisted value', () => {
    for (const v of RATE_TYPE_VALUES) {
      expect(isRateType(v)).toBe(true);
      expect(() => validateRateType({ rate_type: v }, 'r1')).not.toThrow();
    }
  });

  it('treats undefined / null as "not set" (no throw)', () => {
    expect(() => validateRateType({}, 'r1')).not.toThrow();
    expect(() => validateRateType({ rate_type: null }, 'r1')).not.toThrow();
  });

  it('rejects an off-list value with VALIDATION_ERROR (400)', () => {
    expect(() => validateRateType({ rate_type: 'c2c' }, 'r1')).toThrow();
    try {
      validateRateType({ rate_type: 'Corp-to-Corp' }, 'r1');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('VALIDATION_ERROR');
      expect((err as { statusCode?: number }).statusCode).toBe(400);
    }
  });

  it('the allowlist is exactly the four agreed values', () => {
    expect([...RATE_TYPE_VALUES]).toEqual(['C2C', 'W2', '1099', 'Any']);
  });
});
