import { describe, expect, it } from 'vitest';

import { wirePricePointAmount, wirePricePointAttributes } from '../lib/billing/sync/apple-asc-wire.js';

// CCP Billing Products — the App Store Connect wire boundary contract (vocabulary-exempt, PO ruling
// 2026-11-11): Apple's price-point attribute ↔ Aramo's `amount`, nothing else. The attribute shape below
// is copied from a live App Store Connect response (2026-11-11).

describe('App Store Connect wire', () => {
  it('reads the price a price point charges', () => {
    expect(wirePricePointAmount({ customerPrice: '10.0', proceeds: '8.5', proceedsYear2: '8.5' })).toBe('10.0');
  });
  it('returns null for a missing or empty price', () => {
    expect(wirePricePointAmount(undefined)).toBeNull();
    expect(wirePricePointAmount({ proceeds: '8.5' })).toBeNull();
    expect(wirePricePointAmount({ customerPrice: '' })).toBeNull();
  });
  it('round-trips through the inverse used by the fakes', () => {
    expect(wirePricePointAmount(wirePricePointAttributes('999.0'))).toBe('999.0');
  });
});
