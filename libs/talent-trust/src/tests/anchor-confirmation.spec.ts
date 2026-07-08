import { describe, expect, it } from 'vitest';

import { isConfirmingAnchor } from '../lib/anchor-confirmation.js';
import { ANCHOR_KINDS, SOURCE_CLASSES } from '../lib/vocab.js';

// TR-2a-B1 §6(e) — isConfirmingAnchor truth table (DDR-1 §2.1/§2.2/§3.2).
// TR-3 (DDR-1 Amendment v1.2 §6.2) — PLATFORM_VERIFIED joins the confirming set,
// cashed in with its producer. Confirming iff kind ∈ {EMAIL, PHONE} AND
// class ∈ {THIRD_PARTY_VERIFIED, PLATFORM_VERIFIED}. Total and fail-closed over
// ALL SEVEN SourceClass values and any unknown input.
describe('isConfirmingAnchor — confirming/non-confirming projection (DDR-1 §3.2 + Amendment v1.2)', () => {
  const CONFIRMING_CLASSES = new Set(['THIRD_PARTY_VERIFIED', 'PLATFORM_VERIFIED']);

  it('confirms ONLY (EMAIL|PHONE) × {THIRD_PARTY_VERIFIED, PLATFORM_VERIFIED} — full truth table over all seven classes', () => {
    for (const kind of ANCHOR_KINDS) {
      for (const cls of SOURCE_CLASSES) {
        const expected = CONFIRMING_CLASSES.has(cls);
        expect(isConfirmingAnchor(kind, cls)).toBe(expected);
      }
    }
  });

  it('(TR-3 acceptance a) PLATFORM_VERIFIED is confirming for both anchor kinds', () => {
    expect(isConfirmingAnchor('EMAIL', 'PLATFORM_VERIFIED')).toBe(true);
    expect(isConfirmingAnchor('PHONE', 'PLATFORM_VERIFIED')).toBe(true);
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
    expect(isConfirmingAnchor('EMAIL', 'GOV_ID' as never)).toBe(false);
    expect(isConfirmingAnchor('' as never, '' as never)).toBe(false);
  });
});
