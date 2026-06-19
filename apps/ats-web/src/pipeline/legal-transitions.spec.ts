import { describe, expect, it } from 'vitest';

import { LEGAL_TRANSITIONS, legalNextStates } from './legal-transitions';

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
  });

  it('forward edges include the next funnel stage', () => {
    expect(legalNextStates('no_contact')).toContain('contacted');
    expect(legalNextStates('contacted')).toContain('talent_responded');
    expect(legalNextStates('qualifying')).toContain('submitted');
    expect(legalNextStates('offered')).toContain('placed');
  });
});
