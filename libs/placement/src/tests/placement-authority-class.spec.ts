import { describe, expect, it } from 'vitest';

import { LEGAL_TRANSITIONS, STATE_POSITION, edgeAuthorityClass } from '../lib/lifecycle/placement-lifecycle.js';

// Track 3 / E1-b — the authority classification of all 8 legal edges (Approval
// Record §2), derived from the target state's lifecycle position. This IS the
// matrix-to-scope mapping the Gate-6 report cites. L4-0 collapsed the OFFER_*
// states/edges out (offer authority moved to the Offer aggregate).

// The full grounded mapping (edge -> placement:<class> scope). Derived by hand
// from STATE_POSITION and asserted against edgeAuthorityClass so a future edge or
// position change that shifts a class fails here.
const EXPECTED: Record<string, 'transition' | 'activate' | 'terminate'> = {
  'PRE_START->READY_TO_START': 'transition',
  'PRE_START->BLOCKED': 'transition',
  'PRE_START->FELL_THROUGH': 'terminate',
  'BLOCKED->PRE_START': 'transition',
  'BLOCKED->FELL_THROUGH': 'terminate',
  'READY_TO_START->STARTED': 'activate',
  'READY_TO_START->NO_SHOW': 'terminate',
  'READY_TO_START->FELL_THROUGH': 'terminate',
};

describe('placement edge authority classification (§2)', () => {
  it('classifies every one of the 8 legal edges exactly as the grounded mapping', () => {
    expect(LEGAL_TRANSITIONS).toHaveLength(8);
    for (const { from, to } of LEGAL_TRANSITIONS) {
      const key = `${from}->${to}`;
      expect(edgeAuthorityClass(from, to), `edge ${key}`).toBe(EXPECTED[key]);
    }
  });

  it('the derivation is position-driven: TERMINAL->terminate, ENGAGED->activate, else transition', () => {
    for (const { from, to } of LEGAL_TRANSITIONS) {
      const pos = STATE_POSITION[to];
      const cls = edgeAuthorityClass(from, to);
      if (pos === 'TERMINAL') expect(cls).toBe('terminate');
      else if (pos === 'ENGAGED') expect(cls).toBe('activate');
      else expect(cls).toBe('transition');
    }
  });

  it('the split is 3 transition / 1 activate / 4 terminate', () => {
    const tally = LEGAL_TRANSITIONS.reduce<Record<string, number>>((acc, { from, to }) => {
      const c = edgeAuthorityClass(from, to);
      acc[c] = (acc[c] ?? 0) + 1;
      return acc;
    }, {});
    expect(tally).toEqual({ transition: 3, activate: 1, terminate: 4 });
  });
});
