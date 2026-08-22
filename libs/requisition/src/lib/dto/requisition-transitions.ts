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
// Four original operations + the three Approval sub-workflow actions (Amendment
// B). SUBMIT_FOR_APPROVAL / APPROVE / REJECT are governed transitions on the same
// footing as the original four.
export const TRANSITION_ACTIONS = [
  'CLOSE',
  'REOPEN',
  'PUT_ON_HOLD',
  'CANCEL',
  'SUBMIT_FOR_APPROVAL',
  'APPROVE',
  'REJECT',
] as const;
export type TransitionAction = (typeof TRANSITION_ACTIONS)[number];

// The engine resource all transition actions key on (declared status).
export const REQUISITION_RESOURCE = 'REQUISITION';

// The DESTINATION status each governed action lands on. NOTE (Amendment B):
// APPROVE and REOPEN legitimately share the `open` target — the destination is
// NO LONGER a unique key for the action. This map documents each action's target
// (one-way); action RESOLUTION is edge-keyed (governingAction below).
export const ACTION_TARGET_STATUS: Readonly<Record<TransitionAction, RecruitingStatus>> = {
  CLOSE: 'closed',
  REOPEN: 'open',
  PUT_ON_HOLD: 'on_hold',
  CANCEL: 'canceled',
  SUBMIT_FOR_APPROVAL: 'pending_approval',
  APPROVE: 'open',
  REJECT: 'draft',
};

// Amendment B — resolve the governing action for a status change along the
// (from, to) EDGE. The target alone no longer determines the action: `open` is
// the target of BOTH REOPEN (from a governed reopen edge) and APPROVE (from
// `pending_approval`), disambiguated here by the from-status. Targets with a
// single governing edge regardless of origin (closed / on_hold / canceled) still
// resolve by target. `null` means "not a governed transition" — an ORDINARY
// declared-status edit (version-CAS + lifecycle event, no policy gate), e.g.
// `submittals_closed`, `lead`, or ordinary entry into `draft` — NOT "forbidden".
// (The old "target uniquely determines the action" invariant is superseded.)
export function governingAction(
  from: RecruitingStatus,
  to: RecruitingStatus,
): TransitionAction | null {
  switch (to) {
    case 'closed':
      return 'CLOSE';
    case 'on_hold':
      return 'PUT_ON_HOLD';
    case 'canceled':
      return 'CANCEL';
    case 'open':
      // The Amendment-B disambiguation: approval vs. reopen converge on `open`.
      return from === 'pending_approval' ? 'APPROVE' : 'REOPEN';
    case 'pending_approval':
      return from === 'draft' ? 'SUBMIT_FOR_APPROVAL' : null;
    case 'draft':
      return from === 'pending_approval' ? 'REJECT' : null;
    default:
      return null;
  }
}
