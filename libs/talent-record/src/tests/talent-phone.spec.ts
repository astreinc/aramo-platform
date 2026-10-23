import { describe, expect, it } from 'vitest';

import { normalizePhoneForDedupe } from '../lib/talent-phone.js';

// ATI-SEP-1 A2 — the cell-phone dedupe key (must agree with the SQL backfill in
// migration 20261024130000: digits only, a 10-digit number gets country code 1).
describe('normalizePhoneForDedupe', () => {
  it.each([
    ['(571) 435-5777', '15714355777'],
    ['571.435.5777', '15714355777'],
    ['+1 571 435 5777', '15714355777'],
    ['1-571-435-5777', '15714355777'],
    ['+44 20 7946 0958', '442079460958'],
  ])('%s → %s', (raw, key) => {
    expect(normalizePhoneForDedupe(raw)).toBe(key);
  });

  it('no digit / absent → null (never a shared empty key)', () => {
    expect(normalizePhoneForDedupe('n/a')).toBeNull();
    expect(normalizePhoneForDedupe('')).toBeNull();
    expect(normalizePhoneForDedupe(null)).toBeNull();
    expect(normalizePhoneForDedupe(undefined)).toBeNull();
  });
});
