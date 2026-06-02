// PipelineStatus — the 11-state OpenCATS-aligned recruiting funnel +
// the application-layer canTransition guard primitive (PR-A5a Gate 5).
//
// === The state machine (directive §3 + Ruling 1) ===
//
// This is the new concept of PR-A5a. The PR-A2/A3/A4 leaves carried a
// simple stored-status enum (RequisitionStatus etc.) with no transition
// rules. Pipeline is the first ATS leaf with an ENFORCED state machine:
//
//   1. Initial state — every new Pipeline row is created at `no_contact`.
//      `no_status` is included in the enum for legacy-import parity
//      (OpenCATS data may carry it) but the application transition map
//      below never targets it. From `no_status` the legacy row can move
//      forward to `no_contact` / `contacted` / `not_in_consideration`.
//
//   2. Forward progression — the OpenCATS value-ordering captures the
//      recruiting funnel:
//        no_contact → contacted → talent_responded → qualifying →
//        submitted → interviewing → offered → placed
//      Each step has at most one forward neighbor; sane backward
//      correction is permitted (one step back); rejection at any
//      mid-stage exits to `not_in_consideration` or `client_declined`.
//
//   3. Terminal states — `placed`, `not_in_consideration`,
//      `client_declined` have NO outgoing transitions in this matrix.
//      Re-entry of a previously-rejected talent on a re-opened req is
//      a delete + re-create cycle (the Pipeline @@unique constraint on
//      (talent_record_id, requisition_id) blocks duplicate live entries
//      but a deleted row clears the way).
//
//   4. R12 vocabulary — the OpenCATS legacy `_responded` label is
//      renamed `talent_responded` here. The verify-vocabulary.sh
//      Tier-2 gate forbids the legacy anti-token everywhere except
//      the five identity-role-name allowlisted files; this state-
//      machine file is NOT one of them, so the anti-token does not
//      appear in source.
//
// === Atomicity boundary (directive §3 / Ruling 6) ===
//
// canTransition is a PURE guard — no DB access. The repository invokes
// it before opening the `$transaction([...])` so that an illegal
// transition is rejected as INVALID_PIPELINE_TRANSITION before any
// write (no Pipeline.status update, no PipelineStatusHistory row, no
// Activity emit, no metering event). The state-machine proof in apps/
// api/src/tests/ats-batch4a-pipeline.integration.spec.ts asserts this
// atomically: an illegal transition leaves ALL FOUR write targets
// untouched.
//
// === PR-A5a/A5b boundary (Ruling 3) ===
//
// `placed` is reachable as a status here and writes its history +
// activity + metering row as any other transition does — but does NOT
// trigger any sibling-domain write (no requisition.openings decrement,
// no submittal sync). Those are A5b. This state-machine file knows
// nothing about Requisition or TalentSubmittalRecord; the integration
// spec asserts that boundary structurally (no row in requisition.* or
// submittal.* is touched by a transition to placed).

export const PIPELINE_STATUS_VALUES = [
  'no_status',
  'no_contact',
  'contacted',
  'talent_responded',
  'qualifying',
  'submitted',
  'interviewing',
  'offered',
  'not_in_consideration',
  'client_declined',
  'placed',
] as const;

export type PipelineStatus = (typeof PIPELINE_STATUS_VALUES)[number];

export function isPipelineStatus(value: unknown): value is PipelineStatus {
  return (
    typeof value === 'string' &&
    (PIPELINE_STATUS_VALUES as readonly string[]).includes(value)
  );
}

// LEGAL_TRANSITIONS — the proposed transition map (Ruling 1; Lead
// reviews this design at Gate 6).
//
// Each key lists the legal `to` states from the key state. An attempted
// transition not in the list rejects with INVALID_PIPELINE_TRANSITION.
// No-op (`from === to`) is intercepted earlier in the repository and
// never reaches this guard.
//
// Rationale for each forward edge: the next stage of the funnel.
// Rationale for each backward edge: a recruiter-correction within the
// same conversation (e.g. mis-classified; un-step). One step back only.
// Rationale for each terminal-exit edge: rejection at the current stage
// — explicit, not implicit.
const LEGAL_TRANSITIONS: Record<PipelineStatus, readonly PipelineStatus[]> = {
  // Legacy import-only state. Forward edges only; never a target.
  no_status: ['no_contact', 'contacted', 'not_in_consideration'],

  // Initial state. Forward to contacted/talent_responded; back to
  // no_status is intentionally disallowed (would be import-only data).
  no_contact: ['contacted', 'talent_responded', 'not_in_consideration'],

  // Recruiter reached out. Forward to talent_responded; back to
  // no_contact (correction: never actually contacted).
  contacted: [
    'talent_responded',
    'no_contact',
    'not_in_consideration',
  ],

  // Talent responded. Forward to qualifying; back to contacted
  // (correction: response was non-substantive, treat as not-yet-replied).
  talent_responded: [
    'qualifying',
    'contacted',
    'not_in_consideration',
  ],

  // Recruiter qualifying the talent. Forward to submitted (recruiter
  // submits to client); back to talent_responded; or rejection.
  qualifying: ['submitted', 'talent_responded', 'not_in_consideration'],

  // Submitted to client. Forward to interviewing (client schedules);
  // back to qualifying (client returned for more info); rejection
  // paths split: not_in_consideration (recruiter-side drop) or
  // client_declined (client-side drop).
  submitted: [
    'interviewing',
    'qualifying',
    'not_in_consideration',
    'client_declined',
  ],

  // Client interviewing. Forward to offered; back to submitted
  // (additional rounds before offer); rejection paths as above.
  interviewing: [
    'offered',
    'submitted',
    'not_in_consideration',
    'client_declined',
  ],

  // Client offered. Forward to placed (terminal); back to interviewing
  // (offer pulled or further rounds); rejection paths split.
  offered: [
    'placed',
    'interviewing',
    'not_in_consideration',
    'client_declined',
  ],

  // Terminal states — no outgoing transitions. Re-entry is via Pipeline
  // delete + re-create (the @@unique constraint blocks duplicate live
  // rows, but a hard delete clears the row entirely).
  not_in_consideration: [],
  client_declined: [],
  placed: [],
};

/**
 * canTransition — the legal transition guard. Returns true iff the
 * matrix permits `from → to`.
 *
 * No-op (from === to) is treated as legal here so that the repository
 * can early-return without an UPDATE; the directive §2 "no-op guard"
 * intercepts this in the calling layer to avoid an empty history row.
 */
export function canTransition(
  from: PipelineStatus,
  to: PipelineStatus,
): boolean {
  if (from === to) return true;
  return LEGAL_TRANSITIONS[from].includes(to);
}

/**
 * legalNextStates — exposed for callers that want to enumerate the
 * legal moves from a given state (UI affordance, etc.). Not used by
 * the transition path itself.
 */
export function legalNextStates(from: PipelineStatus): readonly PipelineStatus[] {
  return LEGAL_TRANSITIONS[from];
}
