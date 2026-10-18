import { describe, expect, it } from 'vitest';

import { addMonthsClamped, billingPeriodAt } from '../lib/billing-period.js';
import { thresholdOf } from '../lib/allowance.service.js';
import { assertNotProduction } from '../lib/development-subscription.js';

const iso = (d: Date) => d.toISOString();

describe('billing periods (monthly, anchored, no rollover)', () => {
  const anchor = new Date('2026-01-31T15:00:00.000Z');

  it('clamps the anchor day to short months and keeps the time of day', () => {
    expect(iso(addMonthsClamped(anchor, 1))).toBe('2026-02-28T15:00:00.000Z');
    expect(iso(addMonthsClamped(anchor, 2))).toBe('2026-03-31T15:00:00.000Z');
    expect(iso(addMonthsClamped(anchor, 3))).toBe('2026-04-30T15:00:00.000Z');
    expect(iso(addMonthsClamped(anchor, 13))).toBe('2027-02-28T15:00:00.000Z');
  });

  it('finds the period containing an instant, with an exclusive end', () => {
    const p = billingPeriodAt(anchor, new Date('2026-03-15T00:00:00.000Z'));
    expect([iso(p.start), iso(p.end)]).toEqual(['2026-02-28T15:00:00.000Z', '2026-03-31T15:00:00.000Z']);
    const edge = billingPeriodAt(anchor, new Date('2026-03-31T15:00:00.000Z'));
    expect(iso(edge.start)).toBe('2026-03-31T15:00:00.000Z');
    const justBefore = billingPeriodAt(anchor, new Date('2026-03-31T14:59:59.999Z'));
    expect(iso(justBefore.start)).toBe('2026-02-28T15:00:00.000Z');
  });

  it('before the anchor, the first period applies', () => {
    expect(iso(billingPeriodAt(anchor, new Date('2025-12-01T00:00:00.000Z')).start)).toBe(iso(anchor));
  });
});

describe('thresholds', () => {
  it('warns at 80% and is exhausted at 100%', () => {
    expect([79, 80, 99, 100, 101].map((u) => thresholdOf(u, 100))).toEqual(['OK', 'WARNING', 'WARNING', 'EXHAUSTED', 'EXHAUSTED']);
    expect(thresholdOf(0, 0)).toBe('EXHAUSTED');
  });
});

describe('governed development subscriptions', () => {
  it('refuse production and require an explicit local/test environment', () => {
    expect(() => assertNotProduction({ NODE_ENV: 'production', ARAMO_ENV: 'local' })).toThrow(/production/);
    expect(() => assertNotProduction({ ARAMO_ENV: 'prod' })).toThrow(/production/);
    expect(() => assertNotProduction({})).toThrow(/ARAMO_ENV=local/);
    expect(() => assertNotProduction({ ARAMO_ENV: 'local' })).not.toThrow();
  });
});
