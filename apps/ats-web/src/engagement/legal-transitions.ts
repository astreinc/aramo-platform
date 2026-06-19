// LEGAL_TRANSITIONS — hand-mirrored from the inline `const ALLOWED:` map
// in libs/engagement/src/lib/engagement-state.ts's canTransition() (the
// BE source of truth). Amendment v1.1 / RULING 2: importing @aramo/engagement
// is a forbidden domain edge; the engagement matrix is an INLINE const
// (not a top-level export like pipeline's LEGAL_TRANSITIONS), so the drift
// spec's marker is `const ALLOWED:`. Drift is caught by the structural
// deep-equal smoke spec in ./legal-transitions-drift.spec.ts — it reads
// the BE source as text, brace-balances the ALLOWED object, normalizes
// both sides into Record<state, Set<state>>, and asserts matrix equality.
// Any edge added/removed/changed fails the spec.
//
// 11 states, 10 legal transitions, 4 terminals (maybe / passed /
// not_interested / submitted — empty arrays).

import type { EngagementState } from './types';

export const LEGAL_TRANSITIONS: Record<
  EngagementState,
  readonly EngagementState[]
> = {
  surfaced: ['evaluated'],
  evaluated: ['engaged', 'maybe', 'passed'],
  engaged: ['awaiting_response'],
  maybe: [],
  passed: [],
  awaiting_response: ['responded'],
  responded: ['in_conversation'],
  in_conversation: ['not_interested', 'ready_for_submittal'],
  not_interested: [],
  ready_for_submittal: ['submitted'],
  submitted: [],
};

// legalNextStates — the UI affordance helper. Returns the set of states
// the recruiter may move to from `from`. The transition control renders
// ONLY these as options. Also the engaged-gate for the PR-2 composer is
// computed from this for free: legalNextStates('engaged') includes
// 'awaiting_response'.
export function legalNextStates(
  from: EngagementState,
): readonly EngagementState[] {
  return LEGAL_TRANSITIONS[from];
}
