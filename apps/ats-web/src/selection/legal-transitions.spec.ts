import { describe, expect, it } from 'vitest';

import { LEGAL_TRANSITIONS, legalNextStates } from './legal-transitions';

describe('legalNextStates', () => {
  it('returns the legal targets for a non-terminal state', () => {
    expect(legalNextStates('evaluated')).toEqual([
      'engaged',
      'maybe',
      'passed',
    ]);
  });

  it('returns an empty array for terminal states', () => {
    expect(legalNextStates('submitted')).toEqual([]);
    expect(legalNextStates('not_interested')).toEqual([]);
  });

  it('the engaged-state gate is derivable from the mirror (composer §6)', () => {
    // The PR-2 composer surfaces its draft action only from `engaged` —
    // computed for free from the mirror (no extra call).
    expect(legalNextStates('engaged')).toContain('awaiting_response');
    expect(legalNextStates('surfaced')).not.toContain('awaiting_response');
  });

  it('mirrors exactly 11 states', () => {
    expect(Object.keys(LEGAL_TRANSITIONS)).toHaveLength(11);
  });
});
