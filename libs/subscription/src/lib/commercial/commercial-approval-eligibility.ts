import type { CommercialChainStep, CommercialRequiredChain } from './commercial-change-request.js';

// CCP-A3 (Recon Report §1 C2; Charter §6.4; DDR v1.2 §3.2) — the PURE approval-eligibility
// engine. No I/O, no clock: the caller passes `now` and the LIVE operator facts it read
// inside the approve transaction, after `SELECT … FOR UPDATE` on the request (NC-4: never
// a snapshot).
//
// checkApprovalEligibility refuses with exactly one of the seven approved conditions:
//   NOT_PENDING            the request is not PENDING_APPROVAL
//   EXPIRED                now ≥ expires_at (half-open, TD-A2-1)
//   NOT_HUMAN              the actor is not a user principal, or holds no active D9
//                          one-account-per-human attestation
//   SELF_APPROVAL          the actor requested the change (or is the subject of a role
//                          change). Application rule, not a DB CHECK (D8).
//   USER_ALREADY_APPROVED  the actor already approved a step of this request: one user
//                          holding several roles fills at most one step (NC-2)
//   STEP_SCOPE_MISSING     the actor's live roles/scopes do not satisfy the current step
//                          (or any later step)
//   OUT_OF_ORDER           the actor asked for a step other than the next unfilled one,
//                          or qualifies only for a later step
//
// checkChainSatisfiable is the A9 chain-satisfiability gate (Charter §6.3): can the steps
// still unfilled be filled by DISTINCT eligible attested humans other than the requester,
// the subject and the prior approvers? Never a user count.
//
// assertChainStillSatisfiableAtApply is the apply-time re-check (NC-5, ratified by the
// Lead Architect 2026-10-25): every recorded approval is re-checked against the chain
// SNAPSHOTTED on the request — never a newer policy version, so the function takes no
// policy at all — and the live roster. Lost eligibility refuses the apply; the caller
// mutates nothing and never touches the approval rows (the signatures stay as evidence).

export const APPROVAL_REFUSALS = [
  'NOT_PENDING',
  'EXPIRED',
  'NOT_HUMAN',
  'SELF_APPROVAL',
  'USER_ALREADY_APPROVED',
  'STEP_SCOPE_MISSING',
  'OUT_OF_ORDER',
] as const;
export type ApprovalRefusal = (typeof APPROVAL_REFUSALS)[number];

export interface EligibilityRequest {
  state: string;
  requested_by: string;
  /** null while DRAFT (not yet submitted). */
  expires_at: Date | null;
  required_chain: CommercialRequiredChain;
  /** The user a role change is about; null for every other action. */
  subject_user_id: string | null;
}

export interface EligibilityApproval {
  step_index: number;
  approver_user_id: string;
}

/** The actor as read LIVE in the transaction. */
export interface EligibilityActor {
  user_id: string;
  /** From the verified token (`actor_kind`). */
  actor_kind: string;
  /** An active D9 attestation exists for this user. */
  attested: boolean;
  role_keys: readonly string[];
  scopes: readonly string[];
}

export type EligibilityResult =
  | { eligible: true; step_index: number; step: CommercialChainStep }
  | { eligible: false; refusal: ApprovalRefusal; detail: Record<string, unknown> };

export function actorSatisfiesStep(actor: Pick<EligibilityActor, 'role_keys' | 'scopes'>, step: CommercialChainStep): boolean {
  return actor.role_keys.includes(step.role_key) && step.scope_keys.every((s) => actor.scopes.includes(s));
}

function missingFor(actor: Pick<EligibilityActor, 'role_keys' | 'scopes'>, step: CommercialChainStep): { role_key: string | null; scope_keys: string[] } {
  return {
    role_key: actor.role_keys.includes(step.role_key) ? null : step.role_key,
    scope_keys: step.scope_keys.filter((s) => !actor.scopes.includes(s)),
  };
}

/**
 * The seven refusals, in a fixed precedence. `requested_step` is the step the actor asks
 * to approve (the approve route requires it, so a stale client cannot double-advance:
 * NC-1); omitted, the next unfilled step is assumed.
 */
export function checkApprovalEligibility(
  request: EligibilityRequest,
  approvals: readonly EligibilityApproval[],
  actor: EligibilityActor,
  now: Date,
  requested_step?: number,
): EligibilityResult {
  if (request.state !== 'PENDING_APPROVAL') return { eligible: false, refusal: 'NOT_PENDING', detail: { state: request.state } };
  if (request.expires_at === null || now.getTime() >= request.expires_at.getTime()) {
    return { eligible: false, refusal: 'EXPIRED', detail: { expires_at: request.expires_at?.toISOString() ?? null } };
  }
  if (actor.actor_kind !== 'user') return { eligible: false, refusal: 'NOT_HUMAN', detail: { actor_kind: actor.actor_kind } };
  if (!actor.attested) return { eligible: false, refusal: 'NOT_HUMAN', detail: { attestation: 'missing' } };
  if (actor.user_id === request.requested_by) return { eligible: false, refusal: 'SELF_APPROVAL', detail: { requested_by: request.requested_by } };
  if (request.subject_user_id !== null && actor.user_id === request.subject_user_id) {
    return { eligible: false, refusal: 'SELF_APPROVAL', detail: { subject_user_id: request.subject_user_id } };
  }
  const mine = approvals.find((a) => a.approver_user_id === actor.user_id);
  if (mine !== undefined) return { eligible: false, refusal: 'USER_ALREADY_APPROVED', detail: { step_index: mine.step_index } };

  const steps = request.required_chain.steps;
  const next = approvals.length;
  const current = steps[next];
  if (current === undefined) return { eligible: false, refusal: 'NOT_PENDING', detail: { state: request.state, filled_steps: next } };
  if (requested_step !== undefined && requested_step !== next) {
    return { eligible: false, refusal: 'OUT_OF_ORDER', detail: { requested_step, next_step: next } };
  }
  if (actorSatisfiesStep(actor, current)) return { eligible: true, step_index: next, step: current };
  const later = steps.slice(next + 1).find((s) => actorSatisfiesStep(actor, s));
  if (later !== undefined) return { eligible: false, refusal: 'OUT_OF_ORDER', detail: { qualifies_for_step: later.step_index, next_step: next } };
  return { eligible: false, refusal: 'STEP_SCOPE_MISSING', detail: { step_index: next, missing: missingFor(actor, current) } };
}

// ---- Chain satisfiability (A9 gate; 409 CCP_NOT_BOOTSTRAPPED) --------------------------

/** One platform operator as read LIVE (roles, scopes, D9 attestation). */
export interface RosterEntry {
  user_id: string;
  attested: boolean;
  role_keys: readonly string[];
  scopes: readonly string[];
}

export interface ChainSatisfiability {
  satisfiable: boolean;
  /** Unfilled steps no distinct eligible human can take. */
  unfillable_steps: number[];
  /** Number of distinct eligible humans the unfilled steps need. */
  required_humans: number;
}

/**
 * Bipartite matching of the unfilled steps to distinct attested humans who hold the
 * step's role and scopes, excluding `exclude` (requester, subject, prior approvers).
 */
export function checkChainSatisfiable(
  steps: readonly CommercialChainStep[],
  roster: readonly RosterEntry[],
  exclude: ReadonlySet<string>,
): ChainSatisfiability {
  const humans = roster.filter((r) => r.attested && !exclude.has(r.user_id));
  const eligibleFor = steps.map((s) => humans.filter((h) => actorSatisfiesStep(h, s)).map((h) => h.user_id));
  const owner = new Map<string, number>();
  const tryAssign = (i: number, seen: Set<string>): boolean => {
    for (const u of eligibleFor[i] ?? []) {
      if (seen.has(u)) continue;
      seen.add(u);
      const held = owner.get(u);
      if (held === undefined || tryAssign(held, seen)) {
        owner.set(u, i);
        return true;
      }
    }
    return false;
  };
  const unfillable: number[] = [];
  steps.forEach((s, i) => {
    if (!tryAssign(i, new Set())) unfillable.push(s.step_index);
  });
  return { satisfiable: unfillable.length === 0, unfillable_steps: unfillable, required_humans: steps.length };
}

// ---- Apply-time re-check (NC-5; CCP-A6 calls it inside its apply transaction) ---------

export type ApplyRefusalReason =
  | 'NOT_APPROVED' // state is not APPROVED (an expired, rejected or withdrawn request never applies)
  | 'APPROVALS_INCOMPLETE' // the recorded approvals do not cover every snapshotted step exactly once
  | 'APPROVER_NOT_DISTINCT' // one user on two steps, or the requester / subject on a step
  | 'APPROVER_NO_LONGER_ELIGIBLE'; // a signer lost the step's role/scope or the D9 attestation

export class CommercialApplyRefusedError extends Error {
  constructor(
    readonly reason: ApplyRefusalReason,
    readonly detail: Record<string, unknown>,
  ) {
    super(`apply refused (${reason})`);
    this.name = 'CommercialApplyRefusedError';
  }
}

export interface ApplyCheckRequest {
  id: string;
  state: string;
  requested_by: string;
  subject_user_id: string | null;
  /** The chain SNAPSHOTTED at creation (with the request's own policy version). */
  required_chain: CommercialRequiredChain;
  approvals: readonly EligibilityApproval[];
}

/**
 * Throws CommercialApplyRefusedError unless every snapshotted step carries exactly one
 * approval whose signer is, on the LIVE roster, still an attested human holding that
 * step's role and scopes, and the signers are distinct and are neither the requester nor
 * the subject. It reads no policy: revalidation is under the request's own snapshot.
 */
export function assertChainStillSatisfiableAtApply(request: ApplyCheckRequest, liveRoster: readonly RosterEntry[]): void {
  if (request.state !== 'APPROVED') throw new CommercialApplyRefusedError('NOT_APPROVED', { state: request.state });
  const steps = request.required_chain.steps;
  const byStep = new Map<number, EligibilityApproval>();
  for (const a of request.approvals) {
    if (byStep.has(a.step_index)) throw new CommercialApplyRefusedError('APPROVALS_INCOMPLETE', { duplicate_step: a.step_index });
    byStep.set(a.step_index, a);
  }
  if (request.approvals.length !== steps.length || steps.some((s) => !byStep.has(s.step_index))) {
    throw new CommercialApplyRefusedError('APPROVALS_INCOMPLETE', { steps: steps.length, approvals: request.approvals.length });
  }
  const signers = new Set<string>();
  for (const step of steps) {
    const a = byStep.get(step.step_index) as EligibilityApproval;
    if (signers.has(a.approver_user_id) || a.approver_user_id === request.requested_by || a.approver_user_id === request.subject_user_id) {
      throw new CommercialApplyRefusedError('APPROVER_NOT_DISTINCT', { step_index: step.step_index, approver_user_id: a.approver_user_id });
    }
    signers.add(a.approver_user_id);
  }
  for (const step of steps) {
    const a = byStep.get(step.step_index) as EligibilityApproval;
    const live = liveRoster.find((r) => r.user_id === a.approver_user_id);
    if (live === undefined || !live.attested || !actorSatisfiesStep(live, step)) {
      throw new CommercialApplyRefusedError('APPROVER_NO_LONGER_ELIGIBLE', {
        step_index: step.step_index,
        approver_user_id: a.approver_user_id,
        attested: live?.attested ?? false,
        missing: missingFor(live ?? { role_keys: [], scopes: [] }, step),
      });
    }
  }
}
