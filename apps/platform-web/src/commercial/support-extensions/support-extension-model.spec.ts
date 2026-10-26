import { describe, expect, it } from 'vitest';

import { INELIGIBLE_NOT_ATTESTED, INELIGIBLE_NOT_PAST_DUE, breachLine, clauseHelp, ineligibleLine, overlayView, previewExtension, relLabel, statusFact } from './support-extension-model';
import { ME, NOW, PAST_DUE, POLICY, extension } from './support-extension-test-data';

// CCP-B6 — the live preview mirrors the CCP-A8 bound (A2-B inclusive limits, TD-A2-1 half-open
// windows, TD-A8-4 every overlay counts). The server decides; these pin the mirror.

const DAY = 86_400_000;
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
const preview = (days: number, prior = [] as ReturnType<typeof extension>[], subscription = PAST_DUE) => previewExtension({ days, prior, policy: POLICY, subscription, now: NOW });

describe('CCP-B6 previewExtension (mirrors the A8 bound)', () => {
  it('B6-M-LEN 14 days is within bounds (inclusive); 15 escalates LENGTH with the design line', () => {
    expect(preview(14)).toMatchObject({ withinBounds: true, breaches: [] });
    expect(preview(15)).toMatchObject({ withinBounds: false, breaches: ['LENGTH'], why: 'More than 14 days in one extension.' });
  });

  it('B6-M-FREQ a prior extension inside the rolling 90 days escalates; exactly 90 days old has aged out (half-open)', () => {
    expect(preview(2, [extension({ applied_at: at(90 * DAY - 1), days: 2 })])).toMatchObject({ withinBounds: false, breaches: ['FREQUENCY'], why: 'A previous extension was used 90 d ago, inside the 90-day window.' });
    expect(preview(2, [extension({ applied_at: at(90 * DAY), days: 2 })])).toMatchObject({ withinBounds: true });
  });

  it('B6-M-CUM cumulative days over the rolling 365 days: 30 is within the cap, 31 escalates; removed overlays still count (TD-A8-4)', () => {
    const prior = [extension({ applied_at: at(300 * DAY), days: 14 }), extension({ applied_at: at(200 * DAY), days: 14, removed_at: at(190 * DAY), active: false })];
    expect(preview(2, prior)).toMatchObject({ withinBounds: true, use: { uses: 0, cumulative: 28 } });
    expect(preview(3, prior)).toMatchObject({ withinBounds: false, breaches: ['CUMULATIVE'], why: 'Cumulative days would exceed 30.' });
  });

  it('B6-M-ELIG (CCP-R3, TD-A8-3 refined) a row that is not PAST_DUE is NOT eligible: a refusal, never an escalation (no breach is reported for it)', () => {
    expect(preview(3, [], { ...PAST_DUE, status: 'ACTIVE' })).toMatchObject({ eligible: false, withinBounds: true, breaches: [], why: INELIGIBLE_NOT_PAST_DUE });
    // A limit breach on an ineligible row is still shown as the eligibility refusal.
    expect(preview(20, [], { ...PAST_DUE, status: 'ACTIVE' })).toMatchObject({ eligible: false, breaches: ['LENGTH'], why: INELIGIBLE_NOT_PAST_DUE });
    expect(preview(3)).toMatchObject({ eligible: true });
  });

  it('B6-M-NONE no preview without a positive whole number of days, or without a full policy clause (fail closed)', () => {
    expect(preview(0)).toBeNull();
    expect(previewExtension({ days: 3, prior: [], policy: null, subscription: PAST_DUE, now: NOW })).toBeNull();
    expect(previewExtension({ days: 3, prior: [], policy: { ...POLICY, clause: { support_extension_max_days: 14 } }, subscription: PAST_DUE, now: NOW })).toBeNull();
  });

  it('B6-M-ORDER several breaches: the line follows the design order (length, frequency, cumulative)', () => {
    const p = preview(20, [extension({ applied_at: at(5 * DAY), days: 14 })]);
    expect(p?.breaches).toEqual(['LENGTH', 'FREQUENCY', 'CUMULATIVE']);
    expect(p?.why).toBe('More than 14 days in one extension.');
  });
});

describe('CCP-B6 copy helpers', () => {
  it('B6-M-COPY the clause help line, the server breach line, the status fact and the relative stamp', () => {
    expect(clauseHelp(POLICY)).toBe('Policy v1: up to 14 days, once per tenant per 90 days, 30 days cumulative.');
    expect(breachLine(['LENGTH'], POLICY.clause)).toBe('More than 14 days in one extension.');
    expect(ineligibleLine(['REQUESTER_NOT_ATTESTED'])).toBe(INELIGIBLE_NOT_ATTESTED);
    expect(ineligibleLine(['SUBSCRIPTION_NOT_PAST_DUE'])).toMatch(/isn’t past due.*Nothing was requested or escalated\./);
    expect(statusFact(PAST_DUE, NOW)).toEqual({ label: 'Past due · in grace', tone: 'warn', sub: 'Grace ends 29 Oct 2026 (in 4 d)' });
    expect(statusFact({ ...PAST_DUE, grace_until: at(DAY) }, NOW).label).toBe('Past due');
    expect(relLabel(at(3 * 3_600_000), NOW)).toBe('3 h ago');
  });

  it('B6-M-OVERLAY an exception overlay reads as the design card; an approved one is never labelled an exception', () => {
    const ctx = { all: [extension()], policy: POLICY, subscription: PAST_DUE, meId: ME, meName: 'Kwame Mensah', now: NOW };
    expect(overlayView(extension(), ctx)).toMatchObject({
      exception: true,
      ref: 'EXT-0190C000',
      title: '+10 day support extension · applied with zero approvals',
      actor: 'Kwame Mensah · 2026-10-03 16:40 UTC',
      roles: 'Support admin',
      clause: 'Policy v1 — up to 14 days per use, once per tenant per 90 days, 30 days cumulative',
      uses: '1 of 1 in the last 90 days',
      cumulative: '0 → 10 days (cap 30)',
      billing: 'Overlay only — Stripe period and invoices unchanged',
    });
    const approved = overlayView(extension({ is_exception: false }), ctx);
    expect(approved.exception).toBe(false);
    expect(approved.title).not.toMatch(/zero approvals/);
    expect(approved.clause).toMatch(/^Approved through /);
  });
});
