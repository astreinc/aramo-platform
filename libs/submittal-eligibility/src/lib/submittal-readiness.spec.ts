import { describe, expect, it } from 'vitest';

import { deriveSubmittalReadiness } from './submittal-readiness.js';
import type { SubmittalPolicyInputs } from './submittal-eligibility.port.js';

// The NEUTRAL submittal-readiness seam — the shared decision authority both the
// Requisition Talent Board and My Desk compose. It delegates the RULE to
// evaluateEligibility (copies no policy) and returns a neutral result each
// consumer maps to its own display vocabulary. Invariant (TB-4): READY ⟺ every
// applicable gate satisfied; any unresolved/unavailable/blocked gate → needs_action.

const OPEN_INPUTS: SubmittalPolicyInputs = {
  submittal_deadline: null,
  submittal_limit: null,
  manual_override: null,
  submittal_authority: 'ARAMO',
};
const NOW = new Date('2026-01-15T00:00:00.000Z');

const base = {
  policy: { inputs: OPEN_INPUTS, consumed_count: 0 },
  rtr_verdict: null,
  restriction_active: false,
  engagement: 'dormant' as const,
  resume_selected: true,
  now: NOW,
};

describe('deriveSubmittalReadiness (neutral shared authority)', () => {
  it('all applicable gates satisfied → ready_to_submit, no blockers', () => {
    const r = deriveSubmittalReadiness(base);
    expect(r).toEqual({
      band: 'ready_to_submit',
      deny: null,
      engagement_unavailable: false,
      resume_missing: false,
    });
  });

  it('client restriction active → needs_action + TALENT_RESTRICTED_AT_CLIENT', () => {
    const r = deriveSubmittalReadiness({ ...base, restriction_active: true });
    expect(r.band).toBe('needs_action');
    expect(r.deny).toBe('TALENT_RESTRICTED_AT_CLIENT');
  });

  it('window closed (manual override) → needs_action + SUBMITTALS_CLOSED', () => {
    const r = deriveSubmittalReadiness({
      ...base,
      policy: {
        inputs: { ...OPEN_INPUTS, manual_override: 'CLOSED' },
        consumed_count: 0,
      },
    });
    expect(r.band).toBe('needs_action');
    expect(r.deny).toBe('SUBMITTALS_CLOSED');
  });

  it('RTR required but not executed → needs_action + SUBMITTAL_RTR_NOT_EXECUTED', () => {
    const r = deriveSubmittalReadiness({
      ...base,
      rtr_verdict: { satisfied: false, deny: 'SUBMITTAL_RTR_NOT_EXECUTED' },
    });
    expect(r.band).toBe('needs_action');
    expect(r.deny).toBe('SUBMITTAL_RTR_NOT_EXECUTED');
  });

  it('engagement governed but no effective policy → needs_action + POLICY_MISSING deny', () => {
    const r = deriveSubmittalReadiness({ ...base, engagement: 'policy_missing' });
    expect(r.band).toBe('needs_action');
    expect(r.deny).toBe('CLIENT_SUBMITTAL_ENGAGEMENT_POLICY_MISSING');
  });

  it('engagement policy present (not batch-evaluable) → needs_action + engagement_unavailable (never Ready), NOT a policy deny', () => {
    const r = deriveSubmittalReadiness({ ...base, engagement: 'policy_present' });
    expect(r.band).toBe('needs_action');
    expect(r.engagement_unavailable).toBe(true);
    expect(r.deny).toBeNull();
  });

  it('no resume selected → needs_action + resume_missing (orthogonal pre-check, not a policy gate)', () => {
    const r = deriveSubmittalReadiness({ ...base, resume_selected: false });
    expect(r.band).toBe('needs_action');
    expect(r.resume_missing).toBe(true);
    expect(r.deny).toBeNull();
  });
});
