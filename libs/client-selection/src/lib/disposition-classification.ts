// L3-E(2) — closed, deterministic classification of a DECLINED/WITHDRAWN outcome's effect
// on the upstream qualified Talent+Requisition Pipeline episode.
//
// Ruling: Pipeline is dispositioned to not_in_consideration ONLY when the ClientSelection
// outcome TERMINATES the current qualified consideration episode. If the outcome ends only
// one Submittal/attempt while the Talent remains valid for reconsideration or re-submittal
// on the same requisition, the Pipeline stays qualified. The decision is NEVER inferred
// from free text — it is a closed lookup.
//
//   DECLINED  = client decision against the Talent for THIS requisition → TERMINATES
//               (terminal by default; no reason required).
//   WITHDRAWN = cause-sensitive → the reason_code MUST be one of the closed
//               WithdrawReasonCode values; its effect is looked up here.

export type ConsiderationEffect =
  | 'TERMINATES_CONSIDERATION'
  | 'PRESERVES_QUALIFICATION';

// Closed set of WITHDRAWN causes → effect on the Talent+Requisition episode. (Names use
// grounded Aramo vocabulary — RESUBMITTAL, not the trust-vocabulary-banned equivalent.)
export const WITHDRAW_REASON_EFFECT = {
  // Terminal: the Talent should no longer be considered for this requisition.
  TALENT_WITHDREW: 'TERMINATES_CONSIDERATION',
  TALENT_UNAVAILABLE: 'TERMINATES_CONSIDERATION',
  RECRUITER_DISPOSITIONED: 'TERMINATES_CONSIDERATION',
  // Preserving: only THIS downstream attempt ends; the Talent stays valid for the req.
  ADMIN_CORRECTION: 'PRESERVES_QUALIFICATION',
  RESUBMITTAL: 'PRESERVES_QUALIFICATION',
  CLIENT_PROCESS_CANCELLED: 'PRESERVES_QUALIFICATION',
} as const satisfies Record<string, ConsiderationEffect>;

export type WithdrawReasonCode = keyof typeof WITHDRAW_REASON_EFFECT;

export function isWithdrawReasonCode(x: string | undefined): x is WithdrawReasonCode {
  return x !== undefined && Object.prototype.hasOwnProperty.call(WITHDRAW_REASON_EFFECT, x);
}

// The disposition-driving outcome states (a subset of the terminal ClientSelection states;
// SELECTED is a success terminal that authorizes Offer, never a Pipeline disposition).
export type DispositionOutcomeState = 'DECLINED' | 'WITHDRAWN';

export function isDispositionOutcomeState(s: string): s is DispositionOutcomeState {
  return s === 'DECLINED' || s === 'WITHDRAWN';
}

// The closed classifier. Returns the effect, or null when a WITHDRAWN carries no valid
// closed reason_code — the orchestrator turns null into a deterministic 422 rather than
// guessing (never dispose, never silently preserve, on an unclassifiable withdrawal).
export function considerationEffect(args: {
  to_state: DispositionOutcomeState;
  reason_code?: string;
}): ConsiderationEffect | null {
  if (args.to_state === 'DECLINED') return 'TERMINATES_CONSIDERATION';
  // WITHDRAWN — cause-sensitive, closed lookup only.
  return isWithdrawReasonCode(args.reason_code)
    ? WITHDRAW_REASON_EFFECT[args.reason_code]
    : null;
}
