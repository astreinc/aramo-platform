import { describe, expect, it } from 'vitest';

import { deriveStrength, effectiveStrength } from '../lib/strength.js';
import { METHODS, SOURCE_CLASSES } from '../lib/vocab.js';

// Strength derivation (§6.1) + decay (§7) — pure.

describe('deriveStrength — source_class × method (§6.1)', () => {
  it('a SELF/SELF_DECLARED skill is near-nil; an AUTHORITATIVE_ISSUER/API_REGISTRY degree is high', () => {
    expect(deriveStrength('SELF', 'SELF_DECLARED')).toBeCloseTo(0.05, 5);
    expect(deriveStrength('AUTHORITATIVE_ISSUER', 'API_REGISTRY')).toBeCloseTo(0.9, 5);
  });

  it('is monotonic non-decreasing along the R2 ladder for a fixed method', () => {
    const ranks = SOURCE_CLASSES.map((c) => deriveStrength(c, 'API_REGISTRY'));
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]);
    }
  });

  it('always lands in [0, 1] for every source_class × method pair', () => {
    for (const c of SOURCE_CLASSES) {
      for (const m of METHODS) {
        const s = deriveStrength(c, m);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      }
    }
  });

  // TR-3 acceptance (b) — the new PLATFORM_VERIFIED class ranks between
  // THIRD_PARTY_VERIFIED and AUTHORITATIVE_ISSUER for a fixed method; existing
  // strengths are byte-identical (the ladder insertion is a pure addition).
  it('(TR-3 b) PLATFORM_VERIFIED × CONTROL_ROUND_TRIP lands between TPV and AUTHORITATIVE_ISSUER products', () => {
    const tpv = deriveStrength('THIRD_PARTY_VERIFIED', 'CONTROL_ROUND_TRIP');
    const platform = deriveStrength('PLATFORM_VERIFIED', 'CONTROL_ROUND_TRIP');
    const issuer = deriveStrength('AUTHORITATIVE_ISSUER', 'CONTROL_ROUND_TRIP');
    expect(platform).toBeGreaterThan(tpv);
    expect(platform).toBeLessThan(issuer);
    expect(platform).toBeCloseTo(0.7, 5); // 0.7 weight × 1.0 method
  });

  it('(TR-3 b) existing strengths are unchanged (regression — the ladder insertion adds, never shifts values)', () => {
    expect(deriveStrength('SELF', 'SELF_DECLARED')).toBeCloseTo(0.05, 5);
    expect(deriveStrength('THIRD_PARTY_VERIFIED', 'DOCUMENT')).toBeCloseTo(0.48, 5);
    expect(deriveStrength('AUTHORITATIVE_ISSUER', 'API_REGISTRY')).toBeCloseTo(0.9, 5);
    expect(deriveStrength('BIOMETRIC', 'BIOMETRIC')).toBeCloseTo(0.95, 5);
  });
});

describe('effectiveStrength — decay (§7)', () => {
  const collected = new Date('2026-01-01T00:00:00Z');

  it('DURABLE never decays', () => {
    const later = new Date('2030-01-01T00:00:00Z');
    expect(effectiveStrength(0.9, 'DURABLE', collected, later)).toBe(0.9);
  });

  it('PER_STEP collapses to near-zero shortly after the step', () => {
    const nextDay = new Date('2026-01-02T00:00:00Z');
    expect(effectiveStrength(0.9, 'PER_STEP', collected, nextDay)).toBeCloseTo(0.45, 2);
    const weekLater = new Date('2026-01-08T00:00:00Z');
    expect(effectiveStrength(0.9, 'PER_STEP', collected, weekLater)).toBeLessThan(0.02);
  });

  it('FAST decays faster than SLOW at the same age', () => {
    const sixMonths = new Date('2026-07-01T00:00:00Z');
    const fast = effectiveStrength(1, 'FAST', collected, sixMonths);
    const slow = effectiveStrength(1, 'SLOW', collected, sixMonths);
    expect(fast).toBeLessThan(slow);
  });

  it('treats a future-dated collected_at as age 0 (no negative decay / no boost)', () => {
    const earlier = new Date('2025-12-01T00:00:00Z');
    expect(effectiveStrength(0.6, 'FAST', collected, earlier)).toBe(0.6);
  });
});
