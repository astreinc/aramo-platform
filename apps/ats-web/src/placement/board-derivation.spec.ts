import { describe, expect, it } from 'vitest';

import {
  allowedActions,
  derivePipelineDisplayFromPlacement,
  edgeAuthorityClass,
  reconcile,
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
    const fromExtended = allowedActions('OFFER_EXTENDED', MANAGER);
    expect(fromExtended.some((a) => a.authorityClass === 'terminate')).toBe(true);
  });

  it('a recruiter still gets ordinary progression edges where they exist', () => {
    // OFFER_EXTENDED → OFFER_ACCEPTED is a transition-class edge.
    const fromExtended = allowedActions('OFFER_EXTENDED', RECRUITER);
    expect(fromExtended.some((a) => a.to === 'OFFER_ACCEPTED' && a.authorityClass === 'transition')).toBe(true);
    // READY_TO_START → STARTED is activate-class → recruiter must NOT see it.
    const fromReady = allowedActions('READY_TO_START', RECRUITER);
    expect(fromReady.some((a) => a.to === 'STARTED')).toBe(false);
  });

  it('edgeAuthorityClass keys on the target position', () => {
    expect(edgeAuthorityClass('STARTED')).toBe('activate');
    expect(edgeAuthorityClass('OFFER_DECLINED')).toBe('terminate');
    expect(edgeAuthorityClass('OFFER_ACCEPTED')).toBe('transition');
  });
});

describe('E1-d board derivation — pipeline/placement reconciliation (Proof 9, D-6)', () => {
  it('derives the pipeline display from the authoritative placement state', () => {
    expect(derivePipelineDisplayFromPlacement('STARTED')).toBe('placed');
    expect(derivePipelineDisplayFromPlacement('OFFER_DECLINED')).toBe('client_declined');
    expect(derivePipelineDisplayFromPlacement('FELL_THROUGH')).toBe('client_declined');
    expect(derivePipelineDisplayFromPlacement('OFFER_EXTENDED')).toBe('offered');
    expect(derivePipelineDisplayFromPlacement('READY_TO_START')).toBe('offered');
  });

  // Proof 9 — when pipeline state disagrees with placement, BOTH facts are
  // shown, a mismatch is flagged, placement stays authoritative, and NOTHING
  // is mutated or overwritten.
  it('Proof 9 — a disagreeing pipeline status flags a mismatch WITHOUT overwriting placement', () => {
    // Placement STARTED ⇒ derived 'placed'; the legacy pipeline still says
    // 'offered' → mismatch.
    const r = reconcile('STARTED', 'offered');
    expect(r.mismatch).toBe(true);
    // Placement remains authoritative for eligibility — not rewritten to pipeline.
    expect(r.authoritativeState).toBe('STARTED');
    expect(r.derivedPipelineDisplay).toBe('placed');
    // Both facts are carried for display — the legacy pipeline value is preserved.
    expect(r.pipelineStatus).toBe('offered');
  });

  it('agreement → no mismatch; a non-governed pipeline status → never a mismatch', () => {
    expect(reconcile('STARTED', 'placed').mismatch).toBe(false);
    // 'interviewing' is outside placement's governed set → not a mismatch even
    // though it differs from 'placed'.
    expect(reconcile('STARTED', 'interviewing').mismatch).toBe(false);
    // No linked pipeline → no mismatch.
    expect(reconcile('OFFER_EXTENDED', null).mismatch).toBe(false);
  });
});
