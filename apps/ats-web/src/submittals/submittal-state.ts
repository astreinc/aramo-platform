// LEGAL_TRANSITIONS — hand-mirrored from libs/submittal/src/lib/submittal-
// state.ts canTransition / ALLOWED matrix. R6 hand-mirrors instead of
// importing @aramo/submittal (a forbidden domain edge). The drift smoke
// spec at ./submittal-state-drift.spec.ts reads the BE source as text,
// regex-extracts the ALLOWED record, and asserts structural deep-equal.
//
// Mainline chain (4 transitions):
//   created -> handoff_draft -> ready_for_review -> submitted_to_ats
//   -> confirmed
//
// Sibling lifecycle-exit (4 from each non-terminal):
//   created          -> revoked
//   handoff_draft    -> revoked
//   ready_for_review -> revoked
//   submitted_to_ats -> revoked
//
// Terminal: confirmed, revoked.

import type { SubmittalStateValue } from './types';

export const LEGAL_TRANSITIONS: Record<
  SubmittalStateValue,
  readonly SubmittalStateValue[]
> = {
  created: ['handoff_draft', 'revoked'],
  handoff_draft: ['ready_for_review', 'revoked'],
  ready_for_review: ['submitted_to_ats', 'revoked'],
  submitted_to_ats: ['confirmed', 'revoked'],
  confirmed: [],
  revoked: [],
};

export function canTransition(
  from: SubmittalStateValue,
  to: SubmittalStateValue,
): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function isTerminal(state: SubmittalStateValue): boolean {
  return LEGAL_TRANSITIONS[state].length === 0;
}

// The next forward (mainline) state — used by the wizard's "Continue"
// affordance. Returns null at confirmed/revoked (terminal).
export function nextMainlineState(
  state: SubmittalStateValue,
): SubmittalStateValue | null {
  switch (state) {
    case 'created':
      return 'handoff_draft';
    case 'handoff_draft':
      return 'ready_for_review';
    case 'ready_for_review':
      return 'submitted_to_ats';
    case 'submitted_to_ats':
      return 'confirmed';
    case 'confirmed':
    case 'revoked':
      return null;
  }
}

// Whether the recruiter can revoke from this state. Anywhere
// non-terminal that isn't already confirmed/revoked.
export function canRevoke(state: SubmittalStateValue): boolean {
  return state !== 'confirmed' && state !== 'revoked';
}
