import { describe, expect, it } from 'vitest';

import { E164NormalizationError, normalizeToE164 } from '../index.js';

// COMM-B5 — dedicated E.164 normalizer for outbound call dialing. This is a
// SEPARATE contract from the digit-strip within-tenant matcher (`normalizePhone`):
// that one deliberately widens nothing and is a match key; THIS one produces a
// dialable E.164 destination and REFUSES (throws) anything it cannot confidently
// normalize — B5 refuses the call before any provider side effect rather than
// dial arbitrary digits. Assumptions are explicit: a leading `+` is treated as an
// already-qualified international number (validated, not re-inferred); a
// plus-less number is interpreted under the default region (NANP/US) ONLY, and
// anything that is not an unambiguous NANP number is refused.
describe('normalizeToE164 (dialable destination)', () => {
  it('passes through a well-formed E.164 number, stripping formatting', () => {
    expect(normalizeToE164('+1 (555) 234-5678')).toBe('+15552345678');
    expect(normalizeToE164('+44 20 7946 0958')).toBe('+442079460958');
  });

  it('qualifies a 10-digit NANP number under the default US region', () => {
    expect(normalizeToE164('(555) 234-5678')).toBe('+15552345678');
    expect(normalizeToE164('555.234.5678')).toBe('+15552345678');
  });

  it('qualifies an 11-digit NANP number with a leading 1', () => {
    expect(normalizeToE164('1-555-234-5678')).toBe('+15552345678');
  });

  it('refuses an empty or whitespace-only input', () => {
    expect(() => normalizeToE164('')).toThrow(E164NormalizationError);
    expect(() => normalizeToE164('   ')).toThrow(E164NormalizationError);
  });

  it('refuses a plus-less number that is not an unambiguous NANP number', () => {
    // 8 digits — too short to be NANP; region cannot be inferred → refuse.
    expect(() => normalizeToE164('234-5678')).toThrow(E164NormalizationError);
    // 9 digits — ambiguous.
    expect(() => normalizeToE164('123456789')).toThrow(E164NormalizationError);
  });

  it('refuses a NANP number whose area code or exchange starts with 0 or 1', () => {
    // NANP: area code (N) and exchange (N) leading digit must be 2-9.
    expect(() => normalizeToE164('055-234-5678')).toThrow(E164NormalizationError);
    expect(() => normalizeToE164('555-134-5678')).toThrow(E164NormalizationError);
  });

  it('refuses an E.164 number with non-digits after the plus or an out-of-range length', () => {
    expect(() => normalizeToE164('+1-800-CALL-NOW')).toThrow(E164NormalizationError);
    expect(() => normalizeToE164('+1')).toThrow(E164NormalizationError); // too short
    expect(() => normalizeToE164('+1234567890123456')).toThrow(E164NormalizationError); // >15 digits
  });

  it('carries a machine-readable reason on refusal without echoing sensitive internals', () => {
    try {
      normalizeToE164('234-5678');
      throw new Error('expected refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(E164NormalizationError);
      expect((err as E164NormalizationError).reason).toBe('not_normalizable');
    }
  });
});
