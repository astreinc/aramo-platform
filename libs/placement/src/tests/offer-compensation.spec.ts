import { describe, expect, it } from 'vitest';

import {
  classifyOfferCompensation,
  maskOfferCompensation,
  OFFER_COMPENSATION_TYPES,
  OFFER_READ_FINANCIAL_SCOPE,
} from '../lib/offer-compensation.js';

// L4-A / P1 — the structured Talent-facing Offer compensation snapshot validator.
// Pure classification: absent → null (comp optional at DRAFT create); any field
// supplied → all-or-nothing + validated; CONTRACT is sub-annual, PERMANENT is
// ANNUAL. Strictly no bill/margin surface here.
describe('classifyOfferCompensation (L4-A / P1)', () => {
  it('absent comp is OK — null snapshot (optional at create)', () => {
    expect(classifyOfferCompensation({})).toEqual({ ok: true, snapshot: null });
    expect(
      classifyOfferCompensation({ compensation_type: null, compensation_amount: null }),
    ).toEqual({ ok: true, snapshot: null });
  });

  it('accepts a CONTRACT sub-annual pay rate and normalises amount to a decimal string', () => {
    const r = classifyOfferCompensation({
      compensation_type: 'CONTRACT',
      compensation_amount: 85,
      compensation_currency: 'USD',
      compensation_period: 'HOURLY',
    });
    expect(r).toEqual({
      ok: true,
      snapshot: {
        compensation_type: 'CONTRACT',
        compensation_amount: '85',
        compensation_currency: 'USD',
        compensation_period: 'HOURLY',
      },
    });
  });

  it('accepts a PERMANENT ANNUAL base salary', () => {
    const r = classifyOfferCompensation({
      compensation_type: 'PERMANENT',
      compensation_amount: '145000.00',
      compensation_currency: 'EUR',
      compensation_period: 'ANNUAL',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.snapshot?.compensation_type).toBe('PERMANENT');
  });

  it('rejects a partial snapshot (all-or-nothing)', () => {
    expect(
      classifyOfferCompensation({ compensation_type: 'CONTRACT', compensation_amount: 85 }),
    ).toEqual({ ok: false, reason: 'partial_snapshot' });
  });

  it('rejects an unknown compensation_type', () => {
    expect(
      classifyOfferCompensation({
        compensation_type: 'FREELANCE',
        compensation_amount: '10',
        compensation_currency: 'USD',
        compensation_period: 'HOURLY',
      }),
    ).toEqual({ ok: false, reason: 'unknown_type' });
  });

  it('rejects a non-positive / malformed amount (Decimal(12,2) envelope)', () => {
    for (const bad of ['0', '-5', '1.234', 'abc', '12345678901']) {
      expect(
        classifyOfferCompensation({
          compensation_type: 'CONTRACT',
          compensation_amount: bad,
          compensation_currency: 'USD',
          compensation_period: 'HOURLY',
        }),
      ).toEqual({ ok: false, reason: 'invalid_amount' });
    }
  });

  it('rejects an unknown currency and an unknown period', () => {
    expect(
      classifyOfferCompensation({
        compensation_type: 'CONTRACT',
        compensation_amount: '10',
        compensation_currency: 'ZZZ',
        compensation_period: 'HOURLY',
      }),
    ).toEqual({ ok: false, reason: 'unknown_currency' });
    expect(
      classifyOfferCompensation({
        compensation_type: 'CONTRACT',
        compensation_amount: '10',
        compensation_currency: 'USD',
        compensation_period: 'FORTNIGHTLY',
      }),
    ).toEqual({ ok: false, reason: 'unknown_period' });
  });

  it('enforces the period/type contract: CONTRACT sub-annual, PERMANENT ANNUAL', () => {
    // PERMANENT with a sub-annual period → mismatch
    expect(
      classifyOfferCompensation({
        compensation_type: 'PERMANENT',
        compensation_amount: '145000',
        compensation_currency: 'USD',
        compensation_period: 'HOURLY',
      }),
    ).toEqual({ ok: false, reason: 'period_type_mismatch' });
    // CONTRACT with ANNUAL → mismatch
    expect(
      classifyOfferCompensation({
        compensation_type: 'CONTRACT',
        compensation_amount: '85',
        compensation_currency: 'USD',
        compensation_period: 'ANNUAL',
      }),
    ).toEqual({ ok: false, reason: 'period_type_mismatch' });
  });

  it('carries no bill/margin surface — the type set is exactly CONTRACT/PERMANENT', () => {
    expect([...OFFER_COMPENSATION_TYPES]).toEqual(['CONTRACT', 'PERMANENT']);
  });
});

// L4 / P5 — field-level financial masking (fail-closed on offer:read:financial).
describe('maskOfferCompensation (L4 / P5)', () => {
  const full = {
    id: 'o1',
    state: 'SENT',
    compensation_type: 'CONTRACT',
    compensation_amount: '85',
    compensation_currency: 'USD',
    compensation_period: 'HOURLY',
  };

  it('WITH financial visibility → comp fields untouched', () => {
    expect(maskOfferCompensation(full, true)).toEqual(full);
  });

  it('WITHOUT financial visibility → the four comp fields are nulled, everything else intact', () => {
    expect(maskOfferCompensation(full, false)).toEqual({
      id: 'o1',
      state: 'SENT',
      compensation_type: null,
      compensation_amount: null,
      compensation_currency: null,
      compensation_period: null,
    });
  });

  it('the unmask capability is the dedicated offer:read:financial scope', () => {
    expect(OFFER_READ_FINANCIAL_SCOPE).toBe('offer:read:financial');
  });
});
