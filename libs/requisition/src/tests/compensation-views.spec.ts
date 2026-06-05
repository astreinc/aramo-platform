import { describe, expect, it } from 'vitest';

import { Prisma } from '../../prisma/generated/client/client.js';
import { computeDerivedViews } from '../lib/compensation-views.js';

// Compensation-Field Modeling v1.1 — proofs 11, 13, 15 (the derived
// views are pure functions of the two stored facts; mismatch guards;
// Decimal precision must not drift). Proof 12 (individually-omittable
// read fields) is covered by the per-view-null cases below — each
// view is set/null independently of the others on the return shape.

const D = (s: string): Prisma.Decimal => new Prisma.Decimal(s);

describe('compensation-views — computeDerivedViews', () => {
  describe('proof 11 — the PO worked example', () => {
    it('pay=60, bill=80 yields margin_amount=20, markup_percent=33.33, margin_percent=25', () => {
      const views = computeDerivedViews({
        pay_rate_amount: D('60'),
        pay_rate_currency: 'USD',
        pay_rate_period: 'HOURLY',
        bill_rate_amount: D('80'),
        bill_rate_currency: 'USD',
        bill_rate_period: 'HOURLY',
      });
      expect(views.margin_amount).toBe('20.00');
      expect(views.markup_percent).toBe('33.33');
      expect(views.margin_percent).toBe('25.00');
    });
  });

  describe('proof 13 — mismatch guards (NOT crashes)', () => {
    it('currency mismatch → all three views null', () => {
      const views = computeDerivedViews({
        pay_rate_amount: D('60'),
        pay_rate_currency: 'USD',
        pay_rate_period: 'HOURLY',
        bill_rate_amount: D('80'),
        bill_rate_currency: 'EUR',
        bill_rate_period: 'HOURLY',
      });
      expect(views).toEqual({
        margin_amount: null,
        markup_percent: null,
        margin_percent: null,
      });
    });

    it('period mismatch → all three views null', () => {
      const views = computeDerivedViews({
        pay_rate_amount: D('60'),
        pay_rate_currency: 'USD',
        pay_rate_period: 'HOURLY',
        bill_rate_amount: D('80'),
        bill_rate_currency: 'USD',
        bill_rate_period: 'ANNUAL',
      });
      expect(views).toEqual({
        margin_amount: null,
        markup_percent: null,
        margin_percent: null,
      });
    });

    it('missing pay_rate_amount → all three views null', () => {
      const views = computeDerivedViews({
        pay_rate_amount: null,
        pay_rate_currency: 'USD',
        pay_rate_period: 'HOURLY',
        bill_rate_amount: D('80'),
        bill_rate_currency: 'USD',
        bill_rate_period: 'HOURLY',
      });
      expect(views.margin_amount).toBeNull();
      expect(views.markup_percent).toBeNull();
      expect(views.margin_percent).toBeNull();
    });

    it('missing currency on one side → all three views null', () => {
      const views = computeDerivedViews({
        pay_rate_amount: D('60'),
        pay_rate_currency: null,
        pay_rate_period: 'HOURLY',
        bill_rate_amount: D('80'),
        bill_rate_currency: 'USD',
        bill_rate_period: 'HOURLY',
      });
      expect(views.margin_amount).toBeNull();
    });
  });

  describe('proof 15 — Decimal precision (no float drift)', () => {
    it('markup_percent for pay=60/bill=80 yields exactly "33.33" (not 33.333333... or 33.34)', () => {
      const views = computeDerivedViews({
        pay_rate_amount: D('60'),
        pay_rate_currency: 'USD',
        pay_rate_period: 'HOURLY',
        bill_rate_amount: D('80'),
        bill_rate_currency: 'USD',
        bill_rate_period: 'HOURLY',
      });
      expect(views.markup_percent).toBe('33.33');
    });

    it('Decimal round-trip on bill=80.50 / pay=60.25 (fractional cents preserved)', () => {
      const views = computeDerivedViews({
        pay_rate_amount: D('60.25'),
        pay_rate_currency: 'USD',
        pay_rate_period: 'HOURLY',
        bill_rate_amount: D('80.50'),
        bill_rate_currency: 'USD',
        bill_rate_period: 'HOURLY',
      });
      expect(views.margin_amount).toBe('20.25');
    });

    it('high-precision input does not drift through the percent compute', () => {
      // The classic float-drift trap: 0.1 + 0.2 !== 0.3 in float. Use
      // values that would expose float drift if the compute used JS
      // number under the hood — Decimal must hold.
      const views = computeDerivedViews({
        pay_rate_amount: D('0.10'),
        pay_rate_currency: 'USD',
        pay_rate_period: 'HOURLY',
        bill_rate_amount: D('0.30'),
        bill_rate_currency: 'USD',
        bill_rate_period: 'HOURLY',
      });
      // spread = 0.20; markup% = 0.20/0.10 * 100 = 200.00
      expect(views.margin_amount).toBe('0.20');
      expect(views.markup_percent).toBe('200.00');
    });
  });

  describe('proof 12 — derived views are independently nullable', () => {
    it('pay=0 nulls markup_percent but margin_amount and margin_percent still compute', () => {
      const views = computeDerivedViews({
        pay_rate_amount: D('0'),
        pay_rate_currency: 'USD',
        pay_rate_period: 'HOURLY',
        bill_rate_amount: D('80'),
        bill_rate_currency: 'USD',
        bill_rate_period: 'HOURLY',
      });
      expect(views.margin_amount).toBe('80.00');
      expect(views.markup_percent).toBeNull();
      expect(views.margin_percent).toBe('100.00');
    });

    it('bill=0 nulls margin_percent but margin_amount and markup_percent still compute', () => {
      const views = computeDerivedViews({
        pay_rate_amount: D('60'),
        pay_rate_currency: 'USD',
        pay_rate_period: 'HOURLY',
        bill_rate_amount: D('0'),
        bill_rate_currency: 'USD',
        bill_rate_period: 'HOURLY',
      });
      expect(views.margin_amount).toBe('-60.00');
      expect(views.markup_percent).toBe('-100.00');
      expect(views.margin_percent).toBeNull();
    });
  });
});
