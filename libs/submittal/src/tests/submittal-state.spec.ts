import { describe, it, expect } from 'vitest';

import {
  SUBMITTAL_STATE_VALUES,
  canTransition,
  type SubmittalStateValue,
} from '../lib/submittal-state.js';

// M5 PR-8b2 §4.16 — state-guard unit spec for the canonical 5-state
// SubmittalState closed-list tuple + canTransition matrix (replaces
// PR-8b1's M4-name-aware 3-value spec at the rename + cutover phase).
//
// Verifies:
//   - SUBMITTAL_STATE_VALUES exports exactly 6 values (canonical 5 +
//     sibling lifecycle-exit `revoked`).
//   - Ordering matches Group 2 §2.3b Loop 5 chain followed by the
//     revoked sibling.
//   - canTransition accepts the 8 legal transitions
//     (4 mainline + 4 sibling-revoke).
//   - canTransition rejects all illegal transitions across the
//     6 × 6 = 36 transition-pair surface (36 - 8 legal = 28 illegal).
//   - Terminal states `confirmed` and `revoked` reject all outgoing
//     transitions.
//   - Self-transitions are always rejected.

const EXPECTED_VALUES: ReadonlyArray<SubmittalStateValue> = [
  'created',
  'handoff_draft',
  'ready_for_review',
  'submitted_to_ats',
  'confirmed',
  'revoked',
];

const LEGAL_TRANSITIONS: ReadonlyArray<[SubmittalStateValue, SubmittalStateValue]> = [
  // Mainline (4 transitions)
  ['created', 'handoff_draft'],
  ['handoff_draft', 'ready_for_review'],
  ['ready_for_review', 'submitted_to_ats'],
  ['submitted_to_ats', 'confirmed'],
  // Sibling-revoke (4 transitions; Q3 + Ruling 5)
  ['created', 'revoked'],
  ['handoff_draft', 'revoked'],
  ['ready_for_review', 'revoked'],
  ['submitted_to_ats', 'revoked'],
];

const TERMINAL_STATES: ReadonlyArray<SubmittalStateValue> = ['confirmed', 'revoked'];

describe('SUBMITTAL_STATE_VALUES — M5 PR-8b2 canonical 5-state', () => {
  it('exports exactly 6 values', () => {
    expect(SUBMITTAL_STATE_VALUES).toHaveLength(6);
  });

  it('matches the canonical Group 2 §2.3b Loop 5 ordering plus revoked sibling', () => {
    expect([...SUBMITTAL_STATE_VALUES]).toEqual([...EXPECTED_VALUES]);
  });

  it('every expected value is present (set equality)', () => {
    const actual = new Set<string>(SUBMITTAL_STATE_VALUES);
    for (const expected of EXPECTED_VALUES) {
      expect(actual.has(expected)).toBe(true);
    }
    expect(actual.size).toBe(6);
  });

  it('contains all 5 canonical mainline states + sibling revoked', () => {
    expect(SUBMITTAL_STATE_VALUES).toContain('created');
    expect(SUBMITTAL_STATE_VALUES).toContain('handoff_draft');
    expect(SUBMITTAL_STATE_VALUES).toContain('ready_for_review');
    expect(SUBMITTAL_STATE_VALUES).toContain('submitted_to_ats');
    expect(SUBMITTAL_STATE_VALUES).toContain('confirmed');
    expect(SUBMITTAL_STATE_VALUES).toContain('revoked');
  });

  it('does NOT contain M4 legacy names (draft, submitted)', () => {
    expect(SUBMITTAL_STATE_VALUES as readonly string[]).not.toContain('draft');
    expect(SUBMITTAL_STATE_VALUES as readonly string[]).not.toContain('submitted');
  });
});

describe('canTransition — canonical 5-state matrix (8 legal moves)', () => {
  it('accepts the 4 mainline transitions in chain order', () => {
    expect(canTransition('created', 'handoff_draft')).toBe(true);
    expect(canTransition('handoff_draft', 'ready_for_review')).toBe(true);
    expect(canTransition('ready_for_review', 'submitted_to_ats')).toBe(true);
    expect(canTransition('submitted_to_ats', 'confirmed')).toBe(true);
  });

  it('accepts the 4 sibling-revoke transitions (Q3 + Ruling 5)', () => {
    expect(canTransition('created', 'revoked')).toBe(true);
    expect(canTransition('handoff_draft', 'revoked')).toBe(true);
    expect(canTransition('ready_for_review', 'revoked')).toBe(true);
    expect(canTransition('submitted_to_ats', 'revoked')).toBe(true);
  });

  it('accepts all 8 LEGAL_TRANSITIONS pairs', () => {
    expect(LEGAL_TRANSITIONS).toHaveLength(8);
    for (const [from, to] of LEGAL_TRANSITIONS) {
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it('rejects illegal transitions across the 6 × 6 = 36 pair surface', () => {
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
    expect(legalCount).toBe(8);
    expect(illegalCount).toBe(28);
  });

  it('terminal states (confirmed, revoked) reject all outgoing transitions', () => {
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

  it('rejects skip-ahead mainline transitions (no jumping over states)', () => {
    expect(canTransition('created', 'ready_for_review')).toBe(false);
    expect(canTransition('created', 'submitted_to_ats')).toBe(false);
    expect(canTransition('created', 'confirmed')).toBe(false);
    expect(canTransition('handoff_draft', 'submitted_to_ats')).toBe(false);
    expect(canTransition('handoff_draft', 'confirmed')).toBe(false);
    expect(canTransition('ready_for_review', 'confirmed')).toBe(false);
  });

  it('rejects backward mainline transitions (no rewinding)', () => {
    expect(canTransition('handoff_draft', 'created')).toBe(false);
    expect(canTransition('ready_for_review', 'handoff_draft')).toBe(false);
    expect(canTransition('submitted_to_ats', 'ready_for_review')).toBe(false);
    expect(canTransition('confirmed', 'submitted_to_ats')).toBe(false);
  });

  it('rejects sibling-revoke from confirmed (Ruling 5 terminal)', () => {
    expect(canTransition('confirmed', 'revoked')).toBe(false);
  });
});
