// PipelineStatus — the 11-state OpenCATS-aligned recruiting funnel +
// the application-layer canTransition guard primitive (PR-A5a Gate 5).
//
// === The state machine (directive §3 + Ruling 1) ===
//
// This is the new concept of PR-A5a. The PR-A2/A3/A4 leaves carried a
// simple stored-status enum (RecruitingStatus etc.) with no transition
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
  // L2-C (D-6) — affirmative recruiter milestone: "suitable for THIS requisition".
  'qualified',
  'submitted',
  'interviewing',
  'offered',
  'not_in_consideration',
  'client_declined',
  'placed',
  // L2-C (D-2A) — the canonical SUCCESSFUL terminal (system-only COMPLETE; SB-3).
  'completed',
] as const;

export type PipelineStatus = (typeof PIPELINE_STATUS_VALUES)[number];

export function isPipelineStatus(value: unknown): value is PipelineStatus {
  return (
    typeof value === 'string' &&
    (PIPELINE_STATUS_VALUES as readonly string[]).includes(value)
  );
}

// Segment 3 — the ACTIVE funnel, in funnel order. Excludes `no_status`
// (import-legacy, not a real stage) and the three terminal states (placed,
// not_in_consideration, client_declined). This ordering is the single source
// of "most-advanced ACTIVE stage" for the talent-records current_stage
// read-model — apps/api asks pipeline; it never re-derives this ordering.
export const ACTIVE_FLOW_STAGES: readonly PipelineStatus[] = [
  'no_contact',
  'contacted',
  'talent_responded',
  'qualifying',
  // L2-C — `qualified` rests between `qualifying` and `submitted` (ordinal shift intended).
  'qualified',
  'submitted',
  'interviewing',
  'offered',
];

// Funnel ordinal of an ACTIVE stage (higher = more advanced); -1 if the status
// is not an active-flow stage (no_status / terminal).
export function activeStageOrdinal(status: PipelineStatus): number {
  return ACTIVE_FLOW_STAGES.indexOf(status);
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

  // Recruiter qualifying the talent. Forward to `qualified` (QUALIFY — the
  // affirmative milestone); back to talent_responded; or rejection. Lane 2 / L2-E
  // (SB-5 / Q1) — `submitted` is no longer a Pipeline transition target: client
  // submit-to-ats is Submittal-owned (submitted_to_ats), never a Pipeline write.
  qualifying: ['qualified', 'talent_responded', 'not_in_consideration'],

  // The recruiter rests the episode at `qualified`. Back-correction to `qualifying`;
  // rejection to not_in_consideration. `qualified → completed` is legal ONLY so the
  // system COMPLETE command's precondition validates — it is NEVER offered as a
  // recruiter action (§5). Lane 2 / L2-E (SB-5 / Q1) — `qualified → submitted` is
  // removed: after L2-E a new episode rests at `qualified` while the downstream
  // Submittal / Client-Selection / Placement aggregates advance independently.
  qualified: ['qualifying', 'not_in_consideration', 'completed'],

  // Submitted to client. Back to qualifying (client returned for more info);
  // recruiter-side drop to not_in_consideration. Lane 2 / L2-F3 — `interviewing`
  // and `client_declined` are RETIRED as Pipeline transition targets (the interview
  // + client-decline truths are owned by ClientSelectionProcess/InterviewSession,
  // Lane2-DDR §4). Enum values are kept for history; legacy rows already at those
  // states keep their historical rows + their still-valid outgoing edges.
  submitted: ['qualifying', 'not_in_consideration'],

  // Client interviewing (LEGACY source key — no new episode reaches `interviewing`;
  // the interview truth is owned by InterviewSession). A legacy row still exits
  // forward to offered or drops to not_in_consideration. Lane 2 / L2-F3 —
  // `client_declined` is retired as a target here too (client-decline is owner-owned).
  interviewing: ['offered', 'not_in_consideration'],

  // Client offered. Lane 2 / L2-G — the `offered → placed` NEW-write edge is RETIRED:
  // canonical fill is now PlacementProcess *established* (D-1) and successful Pipeline
  // closure is the system-only COMPLETE (SB-3, wired from Placement STARTED). A bare
  // transition to `placed` is refused (INVALID_PIPELINE_TRANSITION 422). The `placed`
  // enum value is KEPT (legacy terminal, §4 tri-state); legacy `placed` rows remain
  // readable (history / company-placements). A legacy offered row still drops to
  // not_in_consideration. (L2-F3 already retired offered → interviewing/client_declined.)
  offered: ['not_in_consideration'],

  // Terminal states — no outgoing transitions. Re-entry rides the E6 live-slot
  // release: a terminal episode frees the (tenant, talent, req) slot, and
  // create() admits a fresh episode (L2-B withdrew the hard delete).
  not_in_consideration: [],
  client_declined: [],
  placed: [],
  // L2-C — the canonical SUCCESSFUL terminal (system-only COMPLETE, SB-3).
  completed: [],
};

// L2-C (SB-2) — EXPLICIT partition registries. After L2-C the empty-edge
// derivation cannot distinguish the CANONICAL successful terminal (`completed`)
// from the LEGACY terminals (`placed`/`client_declined`, kept for history per the
// §4 tri-state) — all have empty legal edges. So the partition is now three
// hand-authored registries, NOT a `LEGAL_TRANSITIONS.length === 0` derivation.
export const CANONICAL_TERMINAL_STATUSES: readonly PipelineStatus[] = [
  'not_in_consideration',
  'completed',
];
export const LEGACY_TERMINAL_STATUSES: readonly PipelineStatus[] = [
  'placed',
  'client_declined',
];
// The live-slot exclusion set = CANONICAL ∪ LEGACY. A status occupies the single
// live-episode slot iff it is NOT in this set. The E6 index-recreate migration
// duplicates this set as a literal SQL `NOT IN (...)` predicate (a migration
// cannot import this module); the B-index-parity drift guard holds the two equal
// (SB-2 — pivoted FROM TERMINAL_STATUSES to this exclusion set).
export const LIVE_EPISODE_EXCLUSION_STATUSES: readonly PipelineStatus[] = [
  ...CANONICAL_TERMINAL_STATUSES,
  ...LEGACY_TERMINAL_STATUSES,
];

// TERMINAL_STATUSES — "all terminals" (empty legal edges). After L2-C this equals
// LIVE_EPISODE_EXCLUSION_STATUSES (all four exclusion members have no outgoing
// edge), but the live-slot partition is now driven by the explicit exclusion
// registry above, not by this derivation (SB-2). Retained for callers that mean
// "has no outgoing transition".
export const TERMINAL_STATUSES: readonly PipelineStatus[] = PIPELINE_STATUS_VALUES.filter(
  (s) => LEGAL_TRANSITIONS[s].length === 0,
);

// isLive — a status occupies the single live-episode slot (Q-2) iff it is NOT in
// the explicit exclusion set (SB-1: historical submitted/interviewing/offered stay
// live-compatible; the four exclusion members are the terminal partition for the
// live slot).
export function isLiveStatus(status: PipelineStatus): boolean {
  return !(LIVE_EPISODE_EXCLUSION_STATUSES as readonly string[]).includes(status);
}

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

// Lane 2 / L2-C (SB-8) — the recruiter named-action surface. Each business action
// maps to exactly ONE to_status; the from-state legality is enforced by
// canTransition (an action illegal from the current status →
// INVALID_PIPELINE_TRANSITION, 422). COMPLETE is deliberately NOT here — it is the
// system-only command (§5), rejected on the recruiter /actions surface.
export const RECRUITER_ACTION_TO_STATUS = {
  CONTACT: 'contacted',
  MARK_RESPONDED: 'talent_responded',
  START_QUALIFICATION: 'qualifying',
  QUALIFY: 'qualified',
  DISPOSITION: 'not_in_consideration',
} as const satisfies Record<string, PipelineStatus>;
export type RecruiterPipelineAction = keyof typeof RECRUITER_ACTION_TO_STATUS;

export function isRecruiterPipelineAction(v: unknown): v is RecruiterPipelineAction {
  return (
    typeof v === 'string' &&
    Object.prototype.hasOwnProperty.call(RECRUITER_ACTION_TO_STATUS, v)
  );
}

// The system-only action name — a body carrying this on the recruiter /actions
// surface is a 422 VALIDATION_ERROR (§5); `completed` is reached only via the
// internal COMPLETE command (pipeline:complete capability).
export const SYSTEM_COMPLETE_ACTION = 'COMPLETE' as const;
