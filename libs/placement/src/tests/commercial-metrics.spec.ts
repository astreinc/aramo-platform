import { describe, expect, it } from 'vitest';

import { Prisma } from '../../prisma/generated/client/client.js';
import { deriveCommercialMetrics } from '../lib/commercial/commercial-metrics.js';

// Track 5 / T5-P2 — D-1 proofs for the canonical commercial derivation (§14). Pure
// Prisma.Decimal math, byte-identical to the ratified compensation-views (DEC-5).
// Boundaries F (spread), G (margin), H (markup), I (no float drift), P (zero denom).

const D = (s: string) => new Prisma.Decimal(s);

describe('deriveCommercialMetrics — DEC-5 canonical derivation', () => {
  // F/G/H/I — the PO worked example (compensation-views §2.2): pay=60, bill=80 →
  // spread=20.00, markup=33.33, margin=25.00. 33.33 proves no float drift (a naive
  // (20/60)*100 float is 33.33333333). Scale-2 decimal strings throughout.
  it('F/G/H/I — pay=60 bill=80 → spread 20.00, margin 25.00, markup 33.33 (no float drift)', () => {
    const m = deriveCommercialMetrics(D('60'), D('80'));
    expect(m.spread_amount).toBe('20.00');
    expect(m.margin_percent).toBe('25.00');
    expect(m.markup_percent).toBe('33.33');
  });

  it('F — exact persisted values: pay=80.00 bill=120.50 → spread 40.50', () => {
    const m = deriveCommercialMetrics(D('80.00'), D('120.50'));
    expect(m.spread_amount).toBe('40.50');
    // margin = 40.50/120.50*100 = 33.61; markup = 40.50/80*100 = 50.625 → 50.63 (half-up)
    expect(m.margin_percent).toBe('33.61');
    expect(m.markup_percent).toBe('50.63');
  });

  // P — zero denominator: NEVER Infinity/NaN, NEVER throw; the specific percentage
  // is null, spread still computes.
  it('P — bill=0 → margin_percent null (spread + markup still compute)', () => {
    const m = deriveCommercialMetrics(D('50'), D('0'));
    expect(m.margin_percent).toBeNull();
    expect(m.spread_amount).toBe('-50.00');
    expect(m.markup_percent).toBe('-100.00'); // (0-50)/50*100
  });
  it('P — pay=0 → markup_percent null (spread + margin still compute)', () => {
    const m = deriveCommercialMetrics(D('0'), D('50'));
    expect(m.markup_percent).toBeNull();
    expect(m.spread_amount).toBe('50.00');
    expect(m.margin_percent).toBe('100.00'); // (50-0)/50*100
  });
  it('P — pay=0 AND bill=0 → both percentages null, spread 0.00 (no NaN/Infinity/throw)', () => {
    const m = deriveCommercialMetrics(D('0'), D('0'));
    expect(m.spread_amount).toBe('0.00');
    expect(m.margin_percent).toBeNull();
    expect(m.markup_percent).toBeNull();
  });

  // Negative spread (pay > bill) is a valid persisted state — computes, never throws.
  it('F — negative spread (pay 120 > bill 100) → spread -20.00', () => {
    const m = deriveCommercialMetrics(D('120'), D('100'));
    expect(m.spread_amount).toBe('-20.00');
    expect(m.margin_percent).toBe('-20.00');
  });
});
