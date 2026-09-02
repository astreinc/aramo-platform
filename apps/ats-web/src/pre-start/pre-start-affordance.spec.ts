import { describe, expect, it } from 'vitest';

import { canMarkReady, requirementActionsFor } from './pre-start-affordance';

// L5-P7 — the governed onboarding affordances, gated by (status × satisfaction_policy
// × scope). The BE is the authority; these prove the surface offers the right actions.

const ALL = [
  'pre_start_requirement:act',
  'pre_start_requirement:verify',
  'pre_start_requirement:waive_blocking',
  'pre_start_requirement:waive_advisory',
  'pre_start_requirement:reopen',
];
const labels = (r: Parameters<typeof requirementActionsFor>[0], scopes: readonly string[]) =>
  requirementActionsFor(r, scopes).map((a) => a.action);

describe('requirementActionsFor — completion vs verification split', () => {
  it('SELF_ATTEST + PENDING + :act → Satisfy + Fail (no Verify)', () => {
    expect(labels({ status: 'PENDING', blocking: true, satisfaction_policy: 'SELF_ATTEST' }, ['pre_start_requirement:act'])).toEqual(['SATISFY', 'FAIL']);
  });

  it('VERIFICATION_REQUIRED + PENDING + :verify → Verify (NOT Satisfy)', () => {
    const a = labels({ status: 'PENDING', blocking: true, satisfaction_policy: 'VERIFICATION_REQUIRED' }, ['pre_start_requirement:verify']);
    expect(a).toContain('VERIFY');
    expect(a).not.toContain('SATISFY');
  });

  it('VERIFICATION_REQUIRED without :verify → no Verify affordance', () => {
    expect(labels({ status: 'PENDING', blocking: true, satisfaction_policy: 'VERIFICATION_REQUIRED' }, ['pre_start_requirement:act'])).not.toContain('VERIFY');
  });

  it('blocking → Waive needs :waive_blocking; advisory → :waive_advisory', () => {
    expect(labels({ status: 'PENDING', blocking: true, satisfaction_policy: 'SELF_ATTEST' }, ['pre_start_requirement:waive_blocking'])).toContain('WAIVE');
    expect(labels({ status: 'PENDING', blocking: true, satisfaction_policy: 'SELF_ATTEST' }, ['pre_start_requirement:waive_advisory'])).not.toContain('WAIVE');
    expect(labels({ status: 'PENDING', blocking: false, satisfaction_policy: 'SELF_ATTEST' }, ['pre_start_requirement:waive_advisory'])).toContain('WAIVE');
  });

  it('a resolved requirement offers Reopen only with :reopen', () => {
    expect(labels({ status: 'SATISFIED', blocking: true, satisfaction_policy: 'SELF_ATTEST' }, ['pre_start_requirement:reopen'])).toEqual(['REOPEN']);
    expect(labels({ status: 'SATISFIED', blocking: true, satisfaction_policy: 'SELF_ATTEST' }, ['pre_start_requirement:act'])).toEqual([]);
  });

  it('a CANCELED requirement offers no work affordances (only reopen with scope)', () => {
    expect(labels({ status: 'CANCELED', blocking: true, satisfaction_policy: 'SELF_ATTEST' }, ALL)).toEqual(['REOPEN']);
  });
});

describe('canMarkReady', () => {
  it('ready + materialized + :act → true', () => {
    expect(canMarkReady({ materialized: true, ready: true }, ['pre_start_requirement:act'])).toBe(true);
  });
  it('not ready → false; no :act → false; not materialized → false', () => {
    expect(canMarkReady({ materialized: true, ready: false }, ['pre_start_requirement:act'])).toBe(false);
    expect(canMarkReady({ materialized: true, ready: true }, [])).toBe(false);
    expect(canMarkReady({ materialized: false, ready: false }, ['pre_start_requirement:act'])).toBe(false);
  });
});
