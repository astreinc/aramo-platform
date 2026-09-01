import { describe, expect, it } from 'vitest';

import {
  allowedActions,
  edgeAuthorityClass,
} from './board-derivation';
import { PLACEMENT_STATE_VALUES, type PlacementState } from './types';

// The role scope-sets under the #577 matrix.
const RECRUITER = ['placement:read', 'placement:create', 'placement:transition'];
const MANAGER = ['placement:read', 'placement:create', 'placement:transition', 'placement:activate', 'placement:terminate'];

describe('E1-d board derivation — action affordances (Proof 8)', () => {
  // Proof 8 — the board must NEVER offer a recruiter an activate or terminate
  // action; the guard would refuse it. Authorization is per target transition.
  it('Proof 8 — a recruiter is never offered an activate or terminate action, from any state', () => {
    for (const state of PLACEMENT_STATE_VALUES) {
      const actions = allowedActions(state as PlacementState, RECRUITER);
      expect(actions.every((a) => a.authorityClass === 'transition')).toBe(true);
      expect(actions.some((a) => a.authorityClass === 'activate')).toBe(false);
      expect(actions.some((a) => a.authorityClass === 'terminate')).toBe(false);
    }
  });

  it('a manager IS offered activate (READY_TO_START→STARTED) and terminate edges', () => {
    const fromReady = allowedActions('READY_TO_START', MANAGER);
    expect(fromReady.some((a) => a.to === 'STARTED' && a.authorityClass === 'activate')).toBe(true);
    // PRE_START → FELL_THROUGH is a terminate-class edge.
    const fromPreStart = allowedActions('PRE_START', MANAGER);
    expect(fromPreStart.some((a) => a.authorityClass === 'terminate')).toBe(true);
  });

  it('a recruiter still gets ordinary progression edges where they exist', () => {
    // PRE_START → READY_TO_START is a transition-class edge.
    const fromPreStart = allowedActions('PRE_START', RECRUITER);
    expect(fromPreStart.some((a) => a.to === 'READY_TO_START' && a.authorityClass === 'transition')).toBe(true);
    // READY_TO_START → STARTED is activate-class → recruiter must NOT see it.
    const fromReady = allowedActions('READY_TO_START', RECRUITER);
    expect(fromReady.some((a) => a.to === 'STARTED')).toBe(false);
  });

  it('edgeAuthorityClass keys on the target position', () => {
    expect(edgeAuthorityClass('STARTED')).toBe('activate');
    expect(edgeAuthorityClass('FELL_THROUGH')).toBe('terminate');
    expect(edgeAuthorityClass('READY_TO_START')).toBe('transition');
  });
});
