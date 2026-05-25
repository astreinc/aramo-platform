import { describe, it, expect } from 'vitest';

import {
  ENGAGEMENT_STATE_VALUES,
  canTransition,
  type EngagementStateValue,
} from '../lib/engagement-state.js';

// M5 PR-1 §4.9 — state-guard unit spec per Amendment v1.1 §4.
//
// Verifies:
//   - ENGAGEMENT_STATE_VALUES exports exactly 11 values.
//   - All 11 values match Amendment v1.1 §2 verbatim Group 2 §2.3b
//     Part 2 Loops 1-5 ordering.
//   - canTransition accepts all 10 legal transitions per Amendment
//     v1.1 §3 / §4.
//   - canTransition rejects all 111 illegal transitions
//     (11 x 11 = 121 transition pairs; 10 legal; 111 illegal).
//   - Terminal states (`maybe`, `passed`, `not_interested`,
//     `submitted`) reject all 11 outgoing transitions.

const EXPECTED_VALUES: ReadonlyArray<EngagementStateValue> = [
  'surfaced',
  'evaluated',
  'engaged',
  'maybe',
  'passed',
  'awaiting_response',
  'responded',
  'in_conversation',
  'not_interested',
  'ready_for_submittal',
  'submitted',
];

const LEGAL_TRANSITIONS: ReadonlyArray<[EngagementStateValue, EngagementStateValue]> = [
  ['surfaced', 'evaluated'],
  ['evaluated', 'engaged'],
  ['evaluated', 'maybe'],
  ['evaluated', 'passed'],
  ['engaged', 'awaiting_response'],
  ['awaiting_response', 'responded'],
  ['responded', 'in_conversation'],
  ['in_conversation', 'not_interested'],
  ['in_conversation', 'ready_for_submittal'],
  ['ready_for_submittal', 'submitted'],
];

const TERMINAL_STATES: ReadonlyArray<EngagementStateValue> = [
  'maybe',
  'passed',
  'not_interested',
  'submitted',
];

describe('ENGAGEMENT_STATE_VALUES — Amendment v1.1 §2 verbatim', () => {
  it('exports exactly 11 values', () => {
    expect(ENGAGEMENT_STATE_VALUES).toHaveLength(11);
  });

  it('matches the Amendment v1.1 §2 verbatim Group 2 §2.3b Part 2 ordering', () => {
    expect([...ENGAGEMENT_STATE_VALUES]).toEqual([...EXPECTED_VALUES]);
  });

  it('every expected value is present (set equality)', () => {
    const actual = new Set<string>(ENGAGEMENT_STATE_VALUES);
    for (const expected of EXPECTED_VALUES) {
      expect(actual.has(expected)).toBe(true);
    }
    expect(actual.size).toBe(11);
  });
});

describe('canTransition — Amendment v1.1 §3 / §4 transition matrix', () => {
  it('accepts all 10 legal transitions', () => {
    expect(LEGAL_TRANSITIONS).toHaveLength(10);
    for (const [from, to] of LEGAL_TRANSITIONS) {
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it('rejects all 111 illegal transitions across the 11 x 11 = 121 pair surface', () => {
    const legalSet = new Set(
      LEGAL_TRANSITIONS.map(([f, t]) => `${f}->${t}`),
    );
    let illegalCount = 0;
    let legalCount = 0;
    for (const from of ENGAGEMENT_STATE_VALUES) {
      for (const to of ENGAGEMENT_STATE_VALUES) {
        const expected = legalSet.has(`${from}->${to}`);
        const actual = canTransition(from, to);
        expect(actual).toBe(expected);
        if (expected) legalCount += 1;
        else illegalCount += 1;
      }
    }
    expect(legalCount).toBe(10);
    expect(illegalCount).toBe(111);
  });

  it('every terminal state rejects all 11 outgoing transitions', () => {
    for (const from of TERMINAL_STATES) {
      for (const to of ENGAGEMENT_STATE_VALUES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('self-transitions are always rejected', () => {
    for (const value of ENGAGEMENT_STATE_VALUES) {
      expect(canTransition(value, value)).toBe(false);
    }
  });
});
