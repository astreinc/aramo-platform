import { describe, expect, it } from 'vitest';

import { LEGAL_TRANSITIONS, legalNextStates } from './legal-transitions';

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

