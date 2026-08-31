// E1-d board derivation — the pure logic behind the placement board's action
// affordances. No React, no I/O, no mutation: given a placement state
// (authoritative) it produces which actions the actor may take. All writes stay
// a separately-authorized seam — reading the board NEVER mutates the resource.
// Placement is owned by the placement lifecycle; there is no Pipeline status to
// reconcile against (Legacy-Pipeline-Canonicalization removed the Pipeline's
// offer/decline/placement representation).

import {
  STATE_POSITION,
  TRANSITIONS,
  type PlacementAuthorityClass,
  type PlacementState,
} from './types';

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

