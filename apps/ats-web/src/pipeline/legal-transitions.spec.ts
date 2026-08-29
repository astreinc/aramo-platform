import { describe, expect, it } from 'vitest';

import {
  LEGAL_TRANSITIONS,
  legalNextStates,
  recruiterNextStates,
  SYSTEM_ONLY_TARGET_STATUSES,
} from './legal-transitions';

describe('legalNextStates', () => {
  it('returns the matrix row for a non-terminal status', () => {
    expect(legalNextStates('no_contact')).toEqual(
      LEGAL_TRANSITIONS.no_contact,
    );
    expect(legalNextStates('submitted')).toEqual(
      LEGAL_TRANSITIONS.submitted,
    );
  });

  it('returns an empty list for terminals', () => {
    expect(legalNextStates('placed')).toEqual([]);
    expect(legalNextStates('not_in_consideration')).toEqual([]);
    expect(legalNextStates('client_declined')).toEqual([]);
    // L2-C — `completed` is the canonical success terminal (no outgoing edges).
    expect(legalNextStates('completed')).toEqual([]);
  });

  it('forward edges include the next funnel stage', () => {
    expect(legalNextStates('no_contact')).toContain('contacted');
    expect(legalNextStates('contacted')).toContain('talent_responded');
    // L2-C — `qualifying`'s affirmative forward edge is now `qualified`. L2-E —
    // `submitted` is no longer a Pipeline transition target (Submittal-owned).
    expect(legalNextStates('qualifying')).toContain('qualified');
    expect(legalNextStates('qualified')).not.toContain('submitted');
    expect(legalNextStates('offered')).toContain('placed');
  });
});

describe('recruiterNextStates (§5 — system-only target exclusion)', () => {
  it('the matrix DOES list qualified → completed (so the system COMPLETE precondition validates)', () => {
    // Non-vacuous: prove the edge is present in the raw matrix BEFORE asserting
    // the recruiter affordance filters it out.
    expect(legalNextStates('qualified')).toContain('completed');
    expect(SYSTEM_ONLY_TARGET_STATUSES).toContain('completed');
  });

  it('a recruiter can never CHOOSE completed as a move target from qualified', () => {
    const targets = recruiterNextStates('qualified');
    expect(targets).not.toContain('completed');
    // L2-E — `submitted` is no longer a target either (Submittal-owned).
    expect(targets).not.toContain('submitted');
    // …the remaining legal recruiter moves survive the filter.
    expect(targets).toContain('qualifying');
    expect(targets).toContain('not_in_consideration');
  });

  it('recruiterNextStates equals the matrix row for any status with no system-only targets', () => {
    expect(recruiterNextStates('qualifying')).toEqual(
      LEGAL_TRANSITIONS.qualifying,
    );
    expect(recruiterNextStates('submitted')).toEqual(
      LEGAL_TRANSITIONS.submitted,
    );
  });
});
