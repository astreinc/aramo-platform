import { describe, expect, it } from 'vitest';

import { formatPhone } from './phone';

describe('formatPhone', () => {
  it('formats a bare 10-digit US number', () => {
    expect(formatPhone('5715644470')).toBe('(571) 564-4470');
    expect(formatPhone('5125550147')).toBe('(512) 555-0147');
  });

  it('folds a leading US country code (11 digits starting with 1)', () => {
    expect(formatPhone('15125550147')).toBe('(512) 555-0147');
  });

  it('normalizes already-punctuated US numbers', () => {
    expect(formatPhone('512-555-0147')).toBe('(512) 555-0147');
    expect(formatPhone('(512) 555 0147')).toBe('(512) 555-0147');
  });

  it('returns non-US / partial / extension values unchanged', () => {
    expect(formatPhone('555-0100')).toBe('555-0100'); // 7 digits
    expect(formatPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
    expect(formatPhone('5125550147x123')).toBe('5125550147x123'); // 13 digits
  });

  it('handles empty / null / undefined', () => {
    expect(formatPhone('')).toBe('');
    expect(formatPhone(null)).toBe('');
    expect(formatPhone(undefined)).toBe('');
  });
});
