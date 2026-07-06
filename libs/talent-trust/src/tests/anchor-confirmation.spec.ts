import { describe, expect, it } from 'vitest';

import { isConfirmingAnchor } from '../lib/anchor-confirmation.js';
import { ANCHOR_KINDS, SOURCE_CLASSES } from '../lib/vocab.js';

// TR-2a-B1 §6(e) — isConfirmingAnchor truth table (DDR-1 §2.1/§2.2/§3.2).
// Confirming iff kind ∈ {EMAIL, PHONE} AND class ∈ {THIRD_PARTY_VERIFIED}.
// Total and fail-closed over ALL SIX SourceClass values and any unknown input.
describe('isConfirmingAnchor — confirming/non-confirming projection (DDR-1 §3.2)', () => {
  it('confirms ONLY (EMAIL|PHONE) × THIRD_PARTY_VERIFIED — full truth table over all six classes', () => {
    for (const kind of ANCHOR_KINDS) {
      for (const cls of SOURCE_CLASSES) {
        const expected = cls === 'THIRD_PARTY_VERIFIED';
        expect(isConfirmingAnchor(kind, cls)).toBe(expected);
      }
    }
  });

  it('the higher independence-ladder classes are non-confirming (no producer — fail-closed, DDR-1 §2.2)', () => {
    // Semantically Tier-A per Spec §6A, but no anchor producer mints them, so
    // they stay non-confirming until a DDR amendment admits each.
    for (const kind of ANCHOR_KINDS) {
      expect(isConfirmingAnchor(kind, 'AUTHORITATIVE_ISSUER')).toBe(false);
      expect(isConfirmingAnchor(kind, 'CRYPTOGRAPHIC')).toBe(false);
      expect(isConfirmingAnchor(kind, 'BIOMETRIC')).toBe(false);
    }
  });

  it('SELF and THIRD_PARTY_UNVERIFIED corroborate, never confirm', () => {
    expect(isConfirmingAnchor('EMAIL', 'SELF')).toBe(false);
    expect(isConfirmingAnchor('EMAIL', 'THIRD_PARTY_UNVERIFIED')).toBe(false);
    expect(isConfirmingAnchor('PHONE', 'SELF')).toBe(false);
    expect(isConfirmingAnchor('PHONE', 'THIRD_PARTY_UNVERIFIED')).toBe(false);
  });

  it('is total and fail-closed for unknown/future kinds and classes (never Tier-A by omission)', () => {
    // Out-of-union values reach this in principle via casts / future vocab.
    expect(isConfirmingAnchor('FUTURE_KIND' as never, 'THIRD_PARTY_VERIFIED')).toBe(false);
    expect(isConfirmingAnchor('EMAIL', 'PLATFORM_VERIFIED' as never)).toBe(false);
    expect(isConfirmingAnchor('EMAIL', 'GOV_ID' as never)).toBe(false);
    expect(isConfirmingAnchor('' as never, '' as never)).toBe(false);
  });
});
