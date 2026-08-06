// E1-d board derivation — the pure logic behind the recruiter-facing derived
// display (Scope C) and the pipeline⊥placement reconciliation (D-6). No React,
// no I/O, no mutation: given a placement state (authoritative) and an optional
// pipeline status (the legacy representation), it produces what the board shows
// and which actions the actor may take. All writes stay a separately-authorized
// seam — reading the board NEVER mutates either resource.

import {
  STATE_POSITION,
  TRANSITIONS,
  type PlacementAuthorityClass,
  type PlacementState,
} from './types';

// The pipeline statuses that PlacementProcess governs as derived display
// (E1-a §1: offered · client_declined · placed become derived from placement
// state). Any other pipeline status is outside placement's authority and never
// flagged as a mismatch.
export type DerivedPipelineDisplay = 'offered' | 'client_declined' | 'placed';
const PLACEMENT_GOVERNED_PIPELINE = new Set<string>(['offered', 'client_declined', 'placed']);

// Map an authoritative placement state to the pipeline display it implies.
//   ENGAGED (STARTED)            → placed
//   TERMINAL (declined/…/fell)   → client_declined
//   otherwise (offer in flight)  → offered
export function derivePipelineDisplayFromPlacement(state: PlacementState): DerivedPipelineDisplay {
  const pos = STATE_POSITION[state];
  if (pos === 'ENGAGED') return 'placed';
  if (pos === 'TERMINAL') return 'client_declined';
  return 'offered';
}

// The authority class the guard will require for a transition INTO `to`
// (mirrors BE edgeAuthorityClass, keyed on the target position).
export function edgeAuthorityClass(to: PlacementState): PlacementAuthorityClass {
  const pos = STATE_POSITION[to];
  if (pos === 'TERMINAL') return 'terminate';
  if (pos === 'ENGAGED') return 'activate';
  return 'transition';
}

export interface PlacementAction {
  readonly to: PlacementState;
  readonly authorityClass: PlacementAuthorityClass;
}

// The actions the board may OFFER for a placement in `state` to an actor holding
// `scopes`. Each legal target edge is classified, then filtered to the exact
// placement:<class> scope the guard will demand — so the UI never renders an
// action the guard would refuse (Proof 8: a recruiter, holding
// placement:transition but NOT placement:activate/terminate, is offered ordinary
// progression edges only; never Start/activate or any terminal action).
// Authorization is evaluated PER TARGET TRANSITION, never via a generic
// "editable placement" flag (D-6).
export function allowedActions(state: PlacementState, scopes: readonly string[]): PlacementAction[] {
  const held = new Set(scopes);
  const out: PlacementAction[] = [];
  for (const to of TRANSITIONS[state]) {
    const authorityClass = edgeAuthorityClass(to);
    if (held.has(`placement:${authorityClass}`)) {
      out.push({ to, authorityClass });
    }
  }
  return out;
}

export interface Reconciliation {
  // The state that governs placement-action eligibility — ALWAYS the placement
  // lifecycle state (authoritative). Never overwritten by pipeline state.
  readonly authoritativeState: PlacementState;
  // What the placement state implies the board column should be.
  readonly derivedPipelineDisplay: DerivedPipelineDisplay;
  // The legacy pipeline status carried alongside, for display (or null when the
  // board row has no linked pipeline).
  readonly pipelineStatus: string | null;
  // True when the linked pipeline status is one placement governs AND it
  // disagrees with the placement-derived display. Informational only in E1-d:
  // the board shows both facts and a deterministic indicator; it triggers NO
  // automatic state rewrite (D-6).
  readonly mismatch: boolean;
}

// Reconcile a placement (authoritative) against an optional legacy pipeline
// status. Pure: returns what to DISPLAY. It never mutates, never infers a
// reason, and never lets pipeline state silently overwrite placement state.
export function reconcile(placementState: PlacementState, pipelineStatus: string | null): Reconciliation {
  const derivedPipelineDisplay = derivePipelineDisplayFromPlacement(placementState);
  const mismatch =
    pipelineStatus !== null &&
    PLACEMENT_GOVERNED_PIPELINE.has(pipelineStatus) &&
    pipelineStatus !== derivedPipelineDisplay;
  return {
    authoritativeState: placementState,
    derivedPipelineDisplay,
    pipelineStatus,
    mismatch,
  };
}
