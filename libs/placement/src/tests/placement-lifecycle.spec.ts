import { describe, expect, it } from 'vitest';

import {
  canTransition,
  canTransitionTyped,
  DUPLICATE_GUARD_INACTIVE,
  INITIAL_STATE,
  LEGAL_TRANSITIONS,
  lifecyclePositionOf,
  PLACEMENT_STATES,
  STATE_POSITION,
  TRANSITION_TERMINAL,
  TRANSITIONS,
  isPlacementGuardReleased,
  type LifecyclePosition,
  type PlacementState,
} from '../lib/lifecycle/placement-lifecycle.js';

// The 14 legal edges, transcribed from the directive §4 table — an
// independent copy so the registry is checked against the directive, not
// against itself.
const DIRECTIVE_EDGES: ReadonlyArray<[PlacementState, PlacementState]> = [
  ['OFFER_EXTENDED', 'OFFER_ACCEPTED'],
  ['OFFER_EXTENDED', 'OFFER_DECLINED'],
  ['OFFER_EXTENDED', 'OFFER_RESCINDED'],
  ['OFFER_ACCEPTED', 'PRE_START'],
  ['OFFER_ACCEPTED', 'OFFER_RESCINDED'],
  ['OFFER_ACCEPTED', 'FELL_THROUGH'],
  ['PRE_START', 'READY_TO_START'],
  ['PRE_START', 'BLOCKED'],
  ['PRE_START', 'FELL_THROUGH'],
  ['BLOCKED', 'PRE_START'],
  ['BLOCKED', 'FELL_THROUGH'],
  ['READY_TO_START', 'STARTED'],
  ['READY_TO_START', 'NO_SHOW'],
  ['READY_TO_START', 'FELL_THROUGH'],
];

describe('PlacementProcess lifecycle registry (§4/§4c/§4d)', () => {
  it('declares exactly the 10 states', () => {
    expect(PLACEMENT_STATES).toHaveLength(10);
    expect(new Set(PLACEMENT_STATES).size).toBe(10);
    expect(INITIAL_STATE).toBe('OFFER_EXTENDED');
  });

  it('every state declares a lifecycle position (§4c exhaustive)', () => {
    for (const s of PLACEMENT_STATES) {
      expect(STATE_POSITION[s]).toBeDefined();
    }
    expect(Object.keys(STATE_POSITION).sort()).toEqual([...PLACEMENT_STATES].sort());
  });

  it('positions match the directive §4c grouping', () => {
    const byPosition: Record<LifecyclePosition, PlacementState[]> = {
      PRE_COMMITMENT: [],
      COMMITTED: [],
      ENGAGED: [],
      TERMINAL: [],
    };
    for (const s of PLACEMENT_STATES) byPosition[lifecyclePositionOf(s)].push(s);
    expect(byPosition.PRE_COMMITMENT).toEqual(['OFFER_EXTENDED']);
    expect(byPosition.COMMITTED).toEqual(['OFFER_ACCEPTED', 'PRE_START', 'BLOCKED', 'READY_TO_START']);
    expect(byPosition.ENGAGED).toEqual(['STARTED']);
    expect(byPosition.TERMINAL).toEqual(['OFFER_DECLINED', 'OFFER_RESCINDED', 'NO_SHOW', 'FELL_THROUGH']);
  });

  it('has exactly the 14 legal edges from the directive', () => {
    expect(LEGAL_TRANSITIONS).toHaveLength(14);
    const got = LEGAL_TRANSITIONS.map((t) => `${t.from}->${t.to}`).sort();
    const want = DIRECTIVE_EDGES.map(([f, t]) => `${f}->${t}`).sort();
    expect(got).toEqual(want);
  });

  it('permits every legal edge and rejects every other pair in the full 10x10 space (§8)', () => {
    const legal = new Set(DIRECTIVE_EDGES.map(([f, t]) => `${f}->${t}`));
    for (const from of PLACEMENT_STATES) {
      for (const to of PLACEMENT_STATES) {
        expect(canTransition(from, to)).toBe(legal.has(`${from}->${to}`));
      }
    }
  });

  it('prohibits the direct OFFER_ACCEPTED -> READY_TO_START edge (§4d)', () => {
    expect(canTransition('OFFER_ACCEPTED', 'READY_TO_START')).toBe(false);
    // PRE_START is the mandatory entry.
    expect(canTransition('OFFER_ACCEPTED', 'PRE_START')).toBe(true);
    expect(canTransition('PRE_START', 'READY_TO_START')).toBe(true);
  });

  it('BLOCKED -> PRE_START is the only recovery edge (§4)', () => {
    expect(canTransition('BLOCKED', 'PRE_START')).toBe(true);
  });

  it('STARTED and the four TERMINAL states have no outgoing edge', () => {
    for (const terminal of ['STARTED', 'OFFER_DECLINED', 'OFFER_RESCINDED', 'NO_SHOW', 'FELL_THROUGH'] as const) {
      expect(TRANSITIONS[terminal]).toEqual([]);
      for (const to of PLACEMENT_STATES) expect(canTransition(terminal, to)).toBe(false);
    }
  });
});

describe('derived classifications DERIVE from lifecycle position (§4c/§5)', () => {
  it('TRANSITION_TERMINAL = TERMINAL ∪ ENGAGED (no outgoing edge)', () => {
    const expected = PLACEMENT_STATES.filter(
      (s) => STATE_POSITION[s] === 'TERMINAL' || STATE_POSITION[s] === 'ENGAGED',
    );
    expect([...TRANSITION_TERMINAL]).toEqual(expected);
    // Every transition-terminal state genuinely has no outgoing edge.
    for (const s of TRANSITION_TERMINAL) expect(TRANSITIONS[s]).toEqual([]);
  });

  it('DUPLICATE_GUARD_INACTIVE = TERMINAL only', () => {
    const expected = PLACEMENT_STATES.filter((s) => STATE_POSITION[s] === 'TERMINAL');
    expect([...DUPLICATE_GUARD_INACTIVE]).toEqual(expected);
    expect([...DUPLICATE_GUARD_INACTIVE]).toEqual([
      'OFFER_DECLINED',
      'OFFER_RESCINDED',
      'NO_SHOW',
      'FELL_THROUGH',
    ]);
  });

  it('STARTED (ENGAGED) is transition-terminal but NOT duplicate-guard-inactive — the one-state-two-roles pivot (§5)', () => {
    expect(TRANSITION_TERMINAL).toContain('STARTED');
    expect(DUPLICATE_GUARD_INACTIVE).not.toContain('STARTED');
    // The two sets are genuinely distinct, not one shared list.
    expect([...TRANSITION_TERMINAL].sort()).not.toEqual([...DUPLICATE_GUARD_INACTIVE].sort());
  });
});

// The COMPILE-TIME enforcement of §6b/§8 (illegal transition = build error,
// exhaustive positions/transitions) lives in a build-included contract file,
// libs/placement/src/lib/lifecycle/placement-lifecycle-contract.ts — a spec
// cannot enforce it because test files are build-excluded and vitest strips
// types. Here we assert only the runtime companion: the typed guard agrees
// with the plain guard on legal edges.
describe('canTransitionTyped agrees with canTransition on legal edges', () => {
  it('accepts the mandatory PRE_START path at runtime', () => {
    expect(canTransitionTyped('OFFER_ACCEPTED', 'PRE_START')).toBe(true);
    expect(canTransitionTyped('PRE_START', 'READY_TO_START')).toBe(true);
  });
});

// Track 4 / T4-C — G2 §3.4 B-predicate-separation. The one-live GUARD-RELEASE
// predicate and E4 replacement eligibility (DUPLICATE_GUARD_INACTIVE) MUST remain
// independently expressed. They diverge exactly at STARTED-with-ended-assignment:
// the guard releases it, E4 does NOT. A plant that made guard-release reuse
// DUPLICATE_GUARD_INACTIVE would make isPlacementGuardReleased('STARTED', true)
// false, failing this proof — the RED that catches a re-unified predicate.
describe('B-predicate-separation: guard-release is independent of E4 eligibility', () => {
  it('STARTED with an ended assignment releases the guard but stays E4-ineligible', () => {
    // Guard release: STARTED + ended assignment => released.
    expect(isPlacementGuardReleased('STARTED', true)).toBe(true);
    // STARTED without an ended assignment is still live (guard held).
    expect(isPlacementGuardReleased('STARTED', false)).toBe(false);
    // E4 eligibility is the SEPARATE set — STARTED is NOT in it (stays ineligible).
    expect((DUPLICATE_GUARD_INACTIVE as readonly PlacementState[]).includes('STARTED')).toBe(false);
    // The two predicates give DIFFERENT answers for STARTED-with-ended — the split.
    expect(isPlacementGuardReleased('STARTED', true)).not.toBe(
      (DUPLICATE_GUARD_INACTIVE as readonly PlacementState[]).includes('STARTED'),
    );
  });

  it('terminal states release the guard AND are E4-eligible (the sets agree there)', () => {
    for (const s of DUPLICATE_GUARD_INACTIVE) {
      expect(isPlacementGuardReleased(s, false)).toBe(true);
    }
  });
});
