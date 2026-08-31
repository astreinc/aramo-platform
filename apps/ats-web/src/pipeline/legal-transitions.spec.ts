import { describe, expect, it } from 'vitest';

import {
  LEGAL_TRANSITIONS,
  legalNextStates,
  recruiterNextStates,
  SYSTEM_ONLY_TARGET_STATUSES,
} from './legal-transitions';

describe('legalNextStates', () => {
  it('returns the matrix row for a non-terminal status', () => {
    expect(legalNextStates('no_contact')).toEqual(LEGAL_TRANSITIONS.no_contact);
    expect(legalNextStates('qualifying')).toEqual(LEGAL_TRANSITIONS.qualifying);
  });

  it('returns an empty list for the two canonical terminals', () => {
    expect(legalNextStates('not_in_consideration')).toEqual([]);
    expect(legalNextStates('completed')).toEqual([]);
  });

  it('forward edges follow the canonical funnel', () => {
    expect(legalNextStates('no_contact')).toContain('contacted');
    expect(legalNextStates('contacted')).toContain('talent_responded');
    expect(legalNextStates('talent_responded')).toContain('qualifying');
    // qualifying's affirmative forward edge is `qualified` (the last Pipeline-owned state).
    expect(legalNextStates('qualifying')).toContain('qualified');
  });

  it('every non-terminal offers a disposition edge to not_in_consideration', () => {
    for (const from of [
      'no_contact',
      'contacted',
      'talent_responded',
      'qualifying',
      'qualified',
    ] as const) {
      expect(legalNextStates(from)).toContain('not_in_consideration');
    }
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
    // …the remaining legal recruiter moves survive the filter.
    expect(targets).toContain('qualifying');
    expect(targets).toContain('not_in_consideration');
  });

  it('recruiterNextStates equals the matrix row for a status with no system-only targets', () => {
    expect(recruiterNextStates('qualifying')).toEqual(LEGAL_TRANSITIONS.qualifying);
    expect(recruiterNextStates('contacted')).toEqual(LEGAL_TRANSITIONS.contacted);
  });
});
