import type { RecruitingStatus } from './requisition-status.js';

// Track 1 T1-e (§2.2) — the GOVERNED requisition transitions.
//
// Four distinct domain operations (§D6): each is a legitimate command a
// recruiter performs, not an override alias for a plain status write. The
// policy engine EVALUATES whether the command may fire from the current
// (declared) status; the domain EXECUTES it (§D14 — evaluator ≠ authority).
//
// This module is the SINGLE SOURCE of the action identifiers + the
// target→action mapping, and it lives in libs/requisition so BOTH the policy
// DATA (apps/api/src/policy/requisition-lifecycle.package.ts) and the domain
// service (RequisitionTransitionPolicyService) import the same literals.
// Duplicating a bare 'CLOSE' string on either side of the port is exactly the
// untyped coupling no compiler/unit/grep catches (the T1-a lesson); a shared
// const closes it.
export const TRANSITION_ACTIONS = ['CLOSE', 'REOPEN', 'PUT_ON_HOLD', 'CANCEL'] as const;
export type TransitionAction = (typeof TRANSITION_ACTIONS)[number];

// The engine resource all four transition actions key on (declared status).
export const REQUISITION_RESOURCE = 'REQUISITION';

// The DESTINATION status each governed action lands on. The action IMPLIES the
// target (§4 Q3 idiom — action-per-transition keyed on from-status, exactly as
// SET_PRIORITY): a governed transition never needs a two-value (from,to) key.
export const ACTION_TARGET_STATUS: Readonly<Record<TransitionAction, RecruitingStatus>> = {
  CLOSE: 'closed',
  REOPEN: 'open',
  PUT_ON_HOLD: 'on_hold',
  CANCEL: 'canceled',
};

// The inverse: which action governs a transition INTO this target. Total over
// the FOUR governed targets only. `submittals_closed` and `lead` are
// recruiter-selectable but have NO governing action (PO ruling, R8 boundary):
// they remain ORDINARY declared-status edits (version-CAS + lifecycle event, no
// policy gate). `undefined` here means "not a governed transition" — NOT
// "forbidden". Gated targets are refused earlier, by isGatedRecruitingStatus.
const TARGET_STATUS_TO_ACTION: Readonly<Partial<Record<RecruitingStatus, TransitionAction>>> = {
  closed: 'CLOSE',
  open: 'REOPEN',
  on_hold: 'PUT_ON_HOLD',
  canceled: 'CANCEL',
};

// Resolve the governing action for a status change INTO `to`, or null when the
// target is not one of the four governed destinations (an ordinary edit).
export function governingActionForTarget(to: RecruitingStatus): TransitionAction | null {
  return TARGET_STATUS_TO_ACTION[to] ?? null;
}
