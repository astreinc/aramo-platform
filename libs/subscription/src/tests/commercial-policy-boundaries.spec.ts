import { describe, expect, it } from 'vitest';

import {
  CommercialPolicyInputError,
  approvalExpiresAt,
  checkSupportExtension,
  creditEscalation,
  discountEscalates,
  isApprovalExpired,
  isWithinPastDueGrace,
  pastDueGraceUntil,
  type AppliedSupportExtension,
} from '../lib/commercial/commercial-policy-boundaries.js';
import { parseCommercialPolicyContent, type CommercialPolicyContent } from '../lib/commercial/commercial-policy.js';

import { seededPolicyV1 } from './fixtures/commercial-policy-seed.js';

// CCP-A2 (PBD §5.1 row A2, mandatory tests) — the exhaustive boundary table at
// 20% / $500 / 14 days / 90 days / 30 days / 72 h / 7 days, each at EXACT, JUST-BELOW and
// JUST-ABOVE, under the PO-confirmed semantics (doc/ccp/slices/CCP-A2-pre-execution.md).
// The policy is the v1 document parsed out of the seeding migration: every threshold is
// DATA. Time boundaries step by 1 ms; amount boundaries by one unit (1 bp, 1 cent, 1 day).

const P: CommercialPolicyContent = parseCommercialPolicyContent(seededPolicyV1().content);
const MS = 1;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-10-24T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ext = (agoMs: number, days: number): AppliedSupportExtension => ({ applied_at: ago(agoMs), days });

describe('CCP-A2 boundary table — discount ≥ 20% escalates (inclusive)', () => {
  const rows: Array<[string, number, boolean]> = [
    ['exact 20.00% (2000 bp)', 2000, true],
    ['just-below 19.99% (1999 bp)', 1999, false],
    ['just-above 20.01% (2001 bp)', 2001, true],
    ['0%', 0, false],
    ['100% (10000 bp)', 10_000, true],
  ];
  for (const [name, bps, escalates] of rows) {
    it(`${name} → ${escalates ? 'ESCALATES' : 'in limit'}`, () => expect(discountEscalates(P, bps)).toBe(escalates));
  }
  it('refuses a fractional, negative or over-100% discount input', () => {
    for (const bad of [1999.5, -1, 10_001]) expect(() => discountEscalates(P, bad)).toThrow(CommercialPolicyInputError);
  });
});

describe('CCP-A2 boundary table — credit ≥ $500.00 (50000 USD minor) escalates (inclusive)', () => {
  const rows: Array<[string, number, boolean]> = [
    ['exact $500.00 (50000)', 50_000, true],
    ['just-below $499.99 (49999)', 49_999, false],
    ['just-above $500.01 (50001)', 50_001, true],
    ['$0.00', 0, false],
  ];
  for (const [name, minor, escalates] of rows) {
    it(`${name} → ${escalates ? 'ESCALATES' : 'in limit'}`, () => {
      expect(creditEscalation(P, { amount_minor: minor, currency: 'USD' }).escalates).toBe(escalates);
    });
  }
  it('a credit in a currency the policy does not denominate escalates (fail closed, no conversion)', () => {
    expect(creditEscalation(P, { amount_minor: 1, currency: 'EUR' })).toEqual({ escalates: true, reason: 'CURRENCY_NOT_COVERED' });
  });
  it('refuses a fractional or negative amount', () => {
    for (const bad of [0.5, -1]) expect(() => creditEscalation(P, { amount_minor: bad, currency: 'USD' })).toThrow(CommercialPolicyInputError);
  });
});

describe('CCP-A2 boundary table — support extension ≤ 14 days is in limit', () => {
  const rows: Array<[string, number, boolean]> = [
    ['exact 14 days', 14, true],
    ['just-below 13 days', 13, true],
    ['just-above 15 days', 15, false],
  ];
  for (const [name, days, within] of rows) {
    it(`${name} → ${within ? 'in limit' : 'ESCALATES (LENGTH)'}`, () => {
      const r = checkSupportExtension(P, { requested_days: days, now: NOW, prior: [] });
      expect(r.within_limit).toBe(within);
      expect(r.breaches).toEqual(within ? [] : ['LENGTH']);
    });
  }
  it('refuses a zero, negative or fractional request', () => {
    for (const bad of [0, -1, 1.5]) expect(() => checkSupportExtension(P, { requested_days: bad, now: NOW, prior: [] })).toThrow(CommercialPolicyInputError);
  });
});

describe('CCP-A2 boundary table — frequency: no in-limit extension in the rolling 90 days before now', () => {
  // One prior 1-day extension; its age relative to now is the boundary under test.
  const rows: Array<[string, number, boolean]> = [
    ['prior exactly 90 days ago (window elapsed)', 90 * DAY, true],
    ['prior just-below 90 days ago (90 d − 1 ms, inside the window)', 90 * DAY - MS, false],
    ['prior just-above 90 days ago (90 d + 1 ms)', 90 * DAY + MS, true],
    ['prior applied now', 0, false],
  ];
  for (const [name, age, within] of rows) {
    it(`${name} → ${within ? 'in limit' : 'ESCALATES (FREQUENCY)'}`, () => {
      const r = checkSupportExtension(P, { requested_days: 1, now: NOW, prior: [ext(age, 1)] });
      expect(r.within_limit).toBe(within);
      expect(r.breaches).toEqual(within ? [] : ['FREQUENCY']);
      expect(r.counters.extensions_in_frequency_window).toBe(within ? 0 : 1);
    });
  }
  it('a prior dated in the future counts (fail closed)', () => {
    expect(checkSupportExtension(P, { requested_days: 1, now: NOW, prior: [ext(-DAY, 1)] }).breaches).toEqual(['FREQUENCY']);
  });
});

describe('CCP-A2 boundary table — cumulative: ≤ 30 in-limit days in any rolling 365-day window', () => {
  // Priors are older than the 90-day frequency window, so only the cumulative cap is in play.
  const rows: Array<[string, AppliedSupportExtension[], number, boolean, number]> = [
    ['exact 30 days (16 prior + 14 requested)', [ext(300 * DAY, 14), ext(200 * DAY, 2)], 14, true, 30],
    ['just-below 29 days (15 prior + 14 requested)', [ext(300 * DAY, 14), ext(200 * DAY, 1)], 14, true, 29],
    ['just-above 31 days (17 prior + 14 requested)', [ext(300 * DAY, 14), ext(200 * DAY, 3)], 14, false, 31],
    ['window edge: a 14-day prior exactly 365 days ago has aged out (14 + 14 = 28)', [ext(365 * DAY, 14), ext(200 * DAY, 14)], 14, true, 28],
    ['window edge: the same prior just inside (365 d − 1 ms) counts (14 + 14 + 14 = 42)', [ext(365 * DAY - MS, 14), ext(200 * DAY, 14)], 14, false, 42],
    ['window edge: the same prior just outside (365 d + 1 ms) (14 + 14 = 28)', [ext(365 * DAY + MS, 14), ext(200 * DAY, 14)], 14, true, 28],
  ];
  for (const [name, prior, requested, within, after] of rows) {
    it(`${name} → ${within ? 'in limit' : 'ESCALATES (CUMULATIVE)'}`, () => {
      const r = checkSupportExtension(P, { requested_days: requested, now: NOW, prior });
      expect(r.within_limit).toBe(within);
      expect(r.breaches).toEqual(within ? [] : ['CUMULATIVE']);
      expect(r.counters.cumulative_days_after).toBe(after);
    });
  }
  it('several breaches are all reported (LENGTH + FREQUENCY + CUMULATIVE)', () => {
    const r = checkSupportExtension(P, { requested_days: 15, now: NOW, prior: [ext(10 * DAY, 14), ext(200 * DAY, 14)] });
    expect(r.breaches).toEqual(['LENGTH', 'FREQUENCY', 'CUMULATIVE']);
    expect(r.counters).toEqual({ requested_days: 15, extensions_in_frequency_window: 1, cumulative_days_before: 28, cumulative_days_after: 43 });
  });
});

describe('CCP-A2 boundary table — approval expiry 72 h (expired AT exactly 72 h)', () => {
  const submitted = ago(0);
  it('expires_at = submitted + 72 h', () => expect(approvalExpiresAt(P, submitted).getTime()).toBe(submitted.getTime() + 72 * HOUR));
  const rows: Array<[string, number, boolean]> = [
    ['exact 72 h after it was submitted', 72 * HOUR, true],
    ['just-below (72 h − 1 ms)', 72 * HOUR - MS, false],
    ['just-above (72 h + 1 ms)', 72 * HOUR + MS, true],
  ];
  for (const [name, elapsed, expired] of rows) {
    it(`${name} → ${expired ? 'EXPIRED' : 'pending'}`, () => {
      expect(isApprovalExpired(P, submitted, new Date(submitted.getTime() + elapsed))).toBe(expired);
    });
  }
});

describe('CCP-A2 boundary table — past-due grace 7 days (ended AT exactly 7 days)', () => {
  const pastDue = ago(0);
  it('grace_until = past_due_at + 7 days', () => expect(pastDueGraceUntil(P, pastDue).getTime()).toBe(pastDue.getTime() + 7 * DAY));
  const rows: Array<[string, number, boolean]> = [
    ['exact 7 days after past-due', 7 * DAY, false],
    ['just-below (7 d − 1 ms)', 7 * DAY - MS, true],
    ['just-above (7 d + 1 ms)', 7 * DAY + MS, false],
  ];
  for (const [name, elapsed, within] of rows) {
    it(`${name} → ${within ? 'within grace' : 'grace ENDED'}`, () => {
      expect(isWithinPastDueGrace(P, pastDue, new Date(pastDue.getTime() + elapsed))).toBe(within);
    });
  }
});

describe('CCP-A2 — the boundaries follow the policy DATA, not constants', () => {
  it('a different policy document moves every boundary', () => {
    const Q = parseCommercialPolicyContent({
      ...P,
      discount_escalation_threshold_bps: 2500,
      credit_escalation_threshold_minor: 100_000,
      support_extension_max_days: 7,
      support_extension_frequency_window_days: 30,
      support_extension_cumulative_max_days: 10,
      support_extension_cumulative_window_days: 180,
      approval_expiry_hours: 24,
      past_due_grace_days: 3,
    });
    expect(discountEscalates(Q, 2000)).toBe(false);
    expect(discountEscalates(Q, 2500)).toBe(true);
    expect(creditEscalation(Q, { amount_minor: 50_000, currency: 'USD' }).escalates).toBe(false);
    expect(checkSupportExtension(Q, { requested_days: 8, now: NOW, prior: [] }).breaches).toEqual(['LENGTH']);
    expect(checkSupportExtension(Q, { requested_days: 1, now: NOW, prior: [ext(30 * DAY, 1)] }).within_limit).toBe(true);
    expect(checkSupportExtension(Q, { requested_days: 7, now: NOW, prior: [ext(100 * DAY, 4)] }).breaches).toEqual(['CUMULATIVE']);
    expect(isApprovalExpired(Q, NOW, new Date(NOW.getTime() + 24 * HOUR))).toBe(true);
    expect(isWithinPastDueGrace(Q, NOW, new Date(NOW.getTime() + 3 * DAY))).toBe(false);
  });
});
