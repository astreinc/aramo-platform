import { describe, expect, it } from 'vitest';

import {
  decimalStringToMinorUnits,
  InvalidMinorUnitsError,
} from '../lib/minor-units.js';

// SRC-2 PR-3 (DEV-D) — the decimal-string → minor-units contract, proven by string
// arithmetic (never float). STATED RULE: >2 fractional digits is REJECTED (the
// source column is Decimal(12,2); advertised comp is never silently distorted).
describe('decimalStringToMinorUnits', () => {
  it('"80.00" → 8000', () => {
    expect(decimalStringToMinorUnits('80.00')).toBe(8000);
  });

  it('"80.5" → 8050 (single fractional digit padded)', () => {
    expect(decimalStringToMinorUnits('80.5')).toBe(8050);
  });

  it('"80.055" → InvalidMinorUnitsError (>2 fractional digits rejected)', () => {
    expect(() => decimalStringToMinorUnits('80.055')).toThrow(
      InvalidMinorUnitsError,
    );
  });

  it('integer string "100" → 10000', () => {
    expect(decimalStringToMinorUnits('100')).toBe(10000);
  });

  it('"0" → 0 and "0.00" → 0', () => {
    expect(decimalStringToMinorUnits('0')).toBe(0);
    expect(decimalStringToMinorUnits('0.00')).toBe(0);
  });

  it('avoids float drift: "80.05" → 8005 (not 8004.999…)', () => {
    expect(decimalStringToMinorUnits('80.05')).toBe(8005);
  });

  it('large value "1234567.89" → 123456789', () => {
    expect(decimalStringToMinorUnits('1234567.89')).toBe(123456789);
  });

  it('rejects non-numeric input', () => {
    expect(() => decimalStringToMinorUnits('abc')).toThrow(InvalidMinorUnitsError);
    expect(() => decimalStringToMinorUnits('')).toThrow(InvalidMinorUnitsError);
    expect(() => decimalStringToMinorUnits('1.2.3')).toThrow(InvalidMinorUnitsError);
  });
});
