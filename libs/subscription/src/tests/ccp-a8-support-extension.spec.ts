import { describe, expect, it } from 'vitest';

import { type AppliedSupportExtension } from '../lib/commercial/commercial-policy-boundaries.js';
import { parseCommercialPolicyContent, type CommercialPolicyContent } from '../lib/commercial/commercial-policy.js';
import {
  CommercialPayloadError,
  boundedExceptionChain,
  parseRequiredChain,
  resolveRequiredChain,
  validatePayload,
} from '../lib/commercial/commercial-change-request.js';
import { decideSupportExtension, overlayCovers, supportExtensionWindow } from '../lib/commercial/support-extension.js';

import { seededPolicyV1 } from './fixtures/commercial-policy-seed.js';

// CCP-A8 (PBD §5.1 row A8 mandatory tests: "in-bound applies with is_exception = true; frequency,
// cumulative and eligibility breaches escalate and never apply; boundary values") — the PURE half.
// The policy is the v1 document parsed out of the A2 seeding migration (every bound is DATA).
// Time steps are 1 ms; day steps are one day. Boundaries are inclusive for the length and the
// cumulative cap (A2-B) and half-open for the windows (TD-A2-1). Test IDs are cited by
// doc/ccp/slices/CCP-A8-acceptance.md.

const P: CommercialPolicyContent = parseCommercialPolicyContent(seededPolicyV1().content);
const DAY = 86_400_000;
const NOW = new Date('2026-10-26T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ext = (agoMs: number, days: number): AppliedSupportExtension => ({ applied_at: ago(agoMs), days });
const decide = (requested_days: number, prior: AppliedSupportExtension[] = [], o: { status?: string; attested?: boolean } = {}) =>
  decideSupportExtension(P, { requested_days, now: NOW, prior, subscription_status: o.status ?? 'PAST_DUE', requester_attested: o.attested ?? true });

describe('CCP-A8 bound table — length ≤ 14 days is within bounds (inclusive)', () => {
  const rows: Array<[string, number, boolean]> = [
    ['A8-B-LEN-1 exact 14 days', 14, true],
    ['A8-B-LEN-2 just-below 13 days', 13, true],
    ['A8-B-LEN-3 just-above 15 days → LENGTH, escalates', 15, false],
    ['A8-B-LEN-4 1 day', 1, true],
  ];
  for (const [name, days, within] of rows) {
    it(name, () => {
      const d = decide(days);
      expect(d.within_bounds).toBe(within);
      expect(d.breaches).toEqual(within ? [] : ['LENGTH']);
    });
  }
});

describe('CCP-A8 breach table — frequency: no extension in the rolling 90 days (half-open)', () => {
  const rows: Array<[string, number, boolean]> = [
    ['A8-B-FREQ-1 prior exactly 90 days old → aged out, within bounds', 90 * DAY, true],
    ['A8-B-FREQ-2 prior 90 days − 1 ms old → FREQUENCY, escalates', 90 * DAY - 1, false],
    ['A8-B-FREQ-3 prior 90 days + 1 ms old → within bounds', 90 * DAY + 1, true],
    ['A8-B-FREQ-4 prior 1 day old → FREQUENCY', DAY, false],
  ];
  for (const [name, age, within] of rows) {
    it(name, () => {
      const d = decide(1, [ext(age, 1)]);
      expect(d.within_bounds).toBe(within);
      expect(d.breaches).toEqual(within ? [] : ['FREQUENCY']);
      expect(d.counters.extensions_in_frequency_window).toBe(within ? 0 : 1);
    });
  }
  it('A8-B-FREQ-5 a prior dated in the future still counts (fail closed)', () => {
    expect(decide(1, [ext(-DAY, 1)]).breaches).toEqual(['FREQUENCY']);
  });
});

describe('CCP-A8 breach table — cumulative ≤ 30 days in the rolling 365 days (inclusive cap, half-open window)', () => {
  // Priors older than the 90-day frequency window, so only the cumulative cap is in play.
  const rows: Array<[string, AppliedSupportExtension[], number, boolean, number]> = [
    ['A8-B-CUM-1 exact 30 (14 + 14 + 2)', [ext(100 * DAY, 14), ext(200 * DAY, 14)], 2, true, 30],
    ['A8-B-CUM-2 just-below 29 (14 + 14 + 1)', [ext(100 * DAY, 14), ext(200 * DAY, 14)], 1, true, 29],
    ['A8-B-CUM-3 just-above 31 (14 + 14 + 3) → CUMULATIVE, escalates', [ext(100 * DAY, 14), ext(200 * DAY, 14)], 3, false, 31],
    ['A8-B-CUM-4 a 14-day prior exactly 365 days old has left the window (14 + 14 + 3 = 17)', [ext(100 * DAY, 14), ext(365 * DAY, 14)], 3, true, 17],
    ['A8-B-CUM-5 a 14-day prior 365 days − 1 ms old still counts (31)', [ext(100 * DAY, 14), ext(365 * DAY - 1, 14)], 3, false, 31],
    ['A8-B-CUM-6 a 14-day prior 365 days + 1 ms old has left the window (17)', [ext(100 * DAY, 14), ext(365 * DAY + 1, 14)], 3, true, 17],
  ];
  for (const [name, prior, requested, within, after] of rows) {
    it(name, () => {
      const d = decide(requested, prior);
      expect(d.within_bounds).toBe(within);
      expect(d.breaches).toEqual(within ? [] : ['CUMULATIVE']);
      expect(d.counters.cumulative_days_after).toBe(after);
    });
  }
});

describe('CCP-A8 breach table — eligibility of the zero-approval act escalates', () => {
  it('A8-B-ELIG-1 a row that is not PAST_DUE (ACTIVE, TRIALING, INCOMPLETE) → ELIGIBILITY / SUBSCRIPTION_NOT_PAST_DUE', () => {
    for (const status of ['ACTIVE', 'TRIALING', 'INCOMPLETE', 'CANCELED']) {
      const d = decide(7, [], { status });
      expect(d.within_bounds, status).toBe(false);
      expect(d.breaches).toEqual(['ELIGIBILITY']);
      expect(d.eligibility).toEqual(['SUBSCRIPTION_NOT_PAST_DUE']);
    }
  });
  it('A8-B-ELIG-2 a requester without an active D9 attestation → ELIGIBILITY / REQUESTER_NOT_ATTESTED', () => {
    const d = decide(7, [], { attested: false });
    expect(d.breaches).toEqual(['ELIGIBILITY']);
    expect(d.eligibility).toEqual(['REQUESTER_NOT_ATTESTED']);
  });
  it('A8-B-ELIG-3 every breach is reported together, with the counter snapshot and the clause', () => {
    const d = decide(15, [ext(10 * DAY, 14), ext(200 * DAY, 14)], { status: 'ACTIVE', attested: false });
    expect(d.breaches).toEqual(['LENGTH', 'FREQUENCY', 'CUMULATIVE', 'ELIGIBILITY']);
    expect(d.eligibility).toEqual(['SUBSCRIPTION_NOT_PAST_DUE', 'REQUESTER_NOT_ATTESTED']);
    expect(d.counters).toEqual({ requested_days: 15, extensions_in_frequency_window: 1, cumulative_days_before: 28, cumulative_days_after: 43 });
    expect(d.clause).toEqual({ support_extension_max_days: 14, support_extension_frequency_window_days: 90, support_extension_cumulative_max_days: 30, support_extension_cumulative_window_days: 365 });
  });
  it('A8-B-ELIG-4 a PAST_DUE row and an attested requester, in bounds → within_bounds', () => {
    expect(decide(14)).toMatchObject({ within_bounds: true, breaches: [], eligibility: [] });
  });
});

describe('CCP-A8 overlay window and coverage (half-open, T8: the window only)', () => {
  it('A8-W-1 grace still running → the extension starts at grace_until', () => {
    const grace = new Date(NOW.getTime() + 3 * DAY);
    expect(supportExtensionWindow(NOW, grace, 14)).toEqual({ base_until: grace, extends_until: new Date(grace.getTime() + 14 * DAY) });
  });
  it('A8-W-2 grace already ended, or none → the extension starts at the apply instant', () => {
    expect(supportExtensionWindow(NOW, ago(DAY), 7)).toEqual({ base_until: NOW, extends_until: new Date(NOW.getTime() + 7 * DAY) });
    expect(supportExtensionWindow(NOW, null, 7)).toEqual({ base_until: NOW, extends_until: new Date(NOW.getTime() + 7 * DAY) });
  });
  it('A8-W-3 coverage is half-open and a removed overlay never covers', () => {
    const until = new Date(NOW.getTime() + DAY);
    expect(overlayCovers({ extends_until: until, removed_at: null }, new Date(until.getTime() - 1))).toBe(true);
    expect(overlayCovers({ extends_until: until, removed_at: null }, until)).toBe(false);
    expect(overlayCovers({ extends_until: until, removed_at: null }, new Date(until.getTime() + 1))).toBe(false);
    expect(overlayCovers({ extends_until: until, removed_at: NOW }, NOW)).toBe(false);
  });
  it('A8-W-4 a non-positive or fractional day count is refused', () => {
    for (const d of [0, -1, 1.5]) expect(() => supportExtensionWindow(NOW, null, d)).toThrow(RangeError);
  });
});

describe('CCP-A8 payload schema, chain and the zero-step BOUNDED_EXCEPTION chain', () => {
  const S = '019a0000-0000-7000-8000-00000000a801';
  it('A8-PL-1 EXTEND and REMOVE admit exactly their keys', () => {
    expect(validatePayload('SUPPORT_EXTENSION', { operation: 'EXTEND', subscription_id: S, requested_days: 14 })).toEqual({ operation: 'EXTEND', subscription_id: S, requested_days: 14 });
    expect(validatePayload('SUPPORT_EXTENSION', { operation: 'REMOVE', support_extension_id: S })).toEqual({ operation: 'REMOVE', support_extension_id: S });
  });
  const bad: Array<[string, unknown]> = [
    ['no operation', { requested_days: 14 }],
    ['unknown operation', { operation: 'GRANT', subscription_id: S, requested_days: 1 }],
    ['EXTEND without subscription_id', { operation: 'EXTEND', requested_days: 1 }],
    ['EXTEND zero days', { operation: 'EXTEND', subscription_id: S, requested_days: 0 }],
    ['EXTEND fractional days', { operation: 'EXTEND', subscription_id: S, requested_days: 1.5 }],
    ['EXTEND extra key', { operation: 'EXTEND', subscription_id: S, requested_days: 1, is_exception: true }],
    ['REMOVE bad id', { operation: 'REMOVE', support_extension_id: 'x' }],
    ['REMOVE extra key', { operation: 'REMOVE', support_extension_id: S, requested_days: 1 }],
  ];
  bad.forEach(([name, p], i) => it(`A8-PL-2.${i + 1} refuses ${name}`, () => expect(() => validatePayload('SUPPORT_EXTENSION', p)).toThrow(CommercialPayloadError)));
  it('A8-CH-1 an escalated extension (Q7) and a removal resolve the Finance-only chain', () => {
    const e = resolveRequiredChain('SUPPORT_EXTENSION', { operation: 'EXTEND', subscription_id: S, requested_days: 20 }, P);
    expect([e.rule, e.steps.map((s) => s.role_key), e.basis]).toEqual(['FINANCE_ONLY', ['finance_admin'], { ruling: 'Q7 escalated support extension' }]);
    const r = resolveRequiredChain('SUPPORT_EXTENSION', { operation: 'REMOVE', support_extension_id: S }, P);
    expect([r.rule, r.steps.map((s) => s.scope_keys), r.basis]).toEqual(['FINANCE_ONLY', [['platform:subscription:approve']], { ruling: 'TD-A8 support extension removal' }]);
  });
  it('A8-CH-2 the bounded chain has zero steps and round-trips; zero steps are refused for any other rule, steps refused for BOUNDED_EXCEPTION', () => {
    const c = boundedExceptionChain({ clause: { a: 1 } });
    expect(parseRequiredChain(JSON.parse(JSON.stringify(c)))).toEqual(c);
    expect(() => parseRequiredChain({ format_version: 1, rule: 'FINANCE_ONLY', steps: [] })).toThrow(/steps/);
    expect(() => parseRequiredChain({ format_version: 1, rule: 'BOUNDED_EXCEPTION', steps: [{ step_index: 0, role_key: 'finance_admin', scope_keys: ['x'] }] })).toThrow(/steps/);
  });
});
