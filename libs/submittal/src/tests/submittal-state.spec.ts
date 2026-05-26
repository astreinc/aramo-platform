import { describe, it, expect } from 'vitest';

import {
  SUBMITTAL_STATE_VALUES,
  canTransition,
  type SubmittalStateValue,
} from '../lib/submittal-state.js';

// M5 PR-8b1 §4.14 — state-guard unit spec for SubmittalState closed-list
// tuple + canTransition matrix.
//
// Verifies:
//   - SUBMITTAL_STATE_VALUES exports exactly 3 values (M4-name-aware
//     per Lead-Q-PR-8b1-B2; PR-8b2 will widen to the canonical 5 +
//     revoked-as-sibling).
//   - All 3 values match the M4 PR-3 + PR-4 + PR-7 substrate ordering.
//   - canTransition accepts the 2 legal M4 transitions
//     (draft → submitted; submitted → revoked).
//   - canTransition rejects all 7 illegal transitions across the
//     3 × 3 = 9 transition-pair surface (9 pairs - 2 legal = 7 illegal).
//   - The terminal `revoked` state rejects all 3 outgoing transitions.
//   - Self-transitions are always rejected.

const EXPECTED_VALUES: ReadonlyArray<SubmittalStateValue> = [
  'draft',
  'submitted',
  'revoked',
];

const LEGAL_TRANSITIONS: ReadonlyArray<[SubmittalStateValue, SubmittalStateValue]> = [
  ['draft', 'submitted'],
  ['submitted', 'revoked'],
];

const TERMINAL_STATES: ReadonlyArray<SubmittalStateValue> = ['revoked'];

describe('SUBMITTAL_STATE_VALUES — M4 substrate verbatim', () => {
  it('exports exactly 3 values', () => {
    expect(SUBMITTAL_STATE_VALUES).toHaveLength(3);
  });

  it('matches the M4 substrate ordering (draft, submitted, revoked)', () => {
    expect([...SUBMITTAL_STATE_VALUES]).toEqual([...EXPECTED_VALUES]);
  });

  it('every expected value is present (set equality)', () => {
    const actual = new Set<string>(SUBMITTAL_STATE_VALUES);
    for (const expected of EXPECTED_VALUES) {
      expect(actual.has(expected)).toBe(true);
    }
    expect(actual.size).toBe(3);
  });
});

describe('canTransition — M4 PR-3 / PR-4 / PR-7 transition matrix', () => {
  it('accepts the 2 legal transitions', () => {
    expect(LEGAL_TRANSITIONS).toHaveLength(2);
    for (const [from, to] of LEGAL_TRANSITIONS) {
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it('rejects all 7 illegal transitions across the 3 × 3 = 9 pair surface', () => {
    const legalSet = new Set(
      LEGAL_TRANSITIONS.map(([f, t]) => `${f}->${t}`),
    );
    let illegalCount = 0;
    let legalCount = 0;
    for (const from of SUBMITTAL_STATE_VALUES) {
      for (const to of SUBMITTAL_STATE_VALUES) {
        const expected = legalSet.has(`${from}->${to}`);
        const actual = canTransition(from, to);
        expect(actual).toBe(expected);
        if (expected) legalCount += 1;
        else illegalCount += 1;
      }
    }
    expect(legalCount).toBe(2);
    expect(illegalCount).toBe(7);
  });

  it('terminal state (revoked) rejects all 3 outgoing transitions', () => {
    for (const from of TERMINAL_STATES) {
      for (const to of SUBMITTAL_STATE_VALUES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('self-transitions are always rejected', () => {
    for (const value of SUBMITTAL_STATE_VALUES) {
      expect(canTransition(value, value)).toBe(false);
    }
  });
});
