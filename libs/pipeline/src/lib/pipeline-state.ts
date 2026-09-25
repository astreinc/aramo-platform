// PipelineStatus — the CANONICAL 7-state recruiting funnel + the
// application-layer canTransition guard primitive.
//
// === Canonical model (Legacy-Pipeline-Canonicalization) ===
//
// The Pipeline owns RECRUITING PROGRESS ONLY. Everything past `qualified`
// (client submittal, interview, offer, placement, assignment) is owned by its
// downstream aggregate — Submittal / ClientSelection·InterviewSession / Offer /
// PlacementProcess — and is NEVER a Pipeline status. This supersedes the earlier
// conservative "keep the enum values for history" posture (Lane2-DDR SB-1): the
// enum is reduced to the canonical seven outright. The superseded values and the
// zero-row census that permitted a clean cast are recorded in the
// canonicalize-status-enum migration header and the closure record, not here.
//
//   1. Initial state — every new Pipeline row is created at `no_contact`.
//   2. Forward progression (the recruiting funnel):
//        no_contact → contacted → talent_responded → qualifying → qualified
//      Each step has at most one forward neighbor; a one-step backward
//      correction is permitted; rejection at any stage exits to
//      `not_in_consideration`.
//   3. Terminal states — `not_in_consideration` (recruiter disposition) and
//      `completed` (system-only success, driven by a downstream Placement
//      STARTED event) have NO outgoing transitions. Re-entry rides the E6
//      live-slot release: a terminal episode frees the (tenant, talent, req)
//      slot and create() admits a fresh episode (L2-B withdrew the hard delete).
//   4. R12 vocabulary — the OpenCATS legacy `_responded` label is renamed
//      `talent_responded`. The verify-vocabulary.sh Tier-2 gate forbids the
//      legacy anti-token everywhere except the identity-role-name allowlisted
//      files; this file is not one of them, so the anti-token never appears here.
//
// === Atomicity boundary ===
//
// canTransition is a PURE guard — no DB access. The repository invokes it before
// opening the `$transaction([...])` so an illegal transition is rejected as
// INVALID_PIPELINE_TRANSITION before any write (no status update, no history row,
// no Activity emit, no metering event).

export const PIPELINE_STATUS_VALUES = [
  'no_contact',
  'contacted',
  'talent_responded',
  'qualifying',
  // affirmative recruiter milestone: "suitable for THIS requisition".
  'qualified',
  'not_in_consideration',
  // the canonical SUCCESSFUL terminal (system-only COMPLETE; SB-3).
  'completed',
  // administrative correction of an accidental Pipeline entry (Accidental-Add
  // Correction Directive). Terminal · non-active · non-recruiting · non-disposition
  // · non-success. Reached ONLY via the governed VOID command (never a generic
  // transition / recruiter /actions), and only from `no_contact`.
  'voided',
] as const;

export type PipelineStatus = (typeof PIPELINE_STATUS_VALUES)[number];

export function isPipelineStatus(value: unknown): value is PipelineStatus {
  return (
    typeof value === 'string' &&
    (PIPELINE_STATUS_VALUES as readonly string[]).includes(value)
  );
}

// The ACTIVE funnel, in funnel order. Excludes the two terminal states. This
// ordering is the single source of "most-advanced ACTIVE stage" for the
// talent-records current_stage read-model — apps/api asks pipeline; it never
// re-derives this ordering.
export const ACTIVE_FLOW_STAGES: readonly PipelineStatus[] = [
  'no_contact',
  'contacted',
  'talent_responded',
  'qualifying',
  'qualified',
];

// Funnel ordinal of an ACTIVE stage (higher = more advanced); -1 if the status
// is not an active-flow stage (terminal).
export function activeStageOrdinal(status: PipelineStatus): number {
  return ACTIVE_FLOW_STAGES.indexOf(status);
}

// LEGAL_TRANSITIONS — the transition map.
//
// Each key lists the legal `to` states from the key state. An attempted
// transition not in the list rejects with INVALID_PIPELINE_TRANSITION. No-op
// (`from === to`) is intercepted earlier in the repository and never reaches
// this guard. Forward edge = the next funnel stage; backward edge = a one-step
// recruiter correction; terminal-exit edge = explicit rejection.
const LEGAL_TRANSITIONS: Record<PipelineStatus, readonly PipelineStatus[]> = {
  // Initial state. Forward to contacted/talent_responded, or rejection.
  no_contact: ['contacted', 'talent_responded', 'not_in_consideration'],

  // Recruiter reached the talent. Forward to talent_responded; back to
  // no_contact (correction: never actually reached).
  contacted: ['talent_responded', 'no_contact', 'not_in_consideration'],

  // Talent responded. Forward to qualifying; back to contacted (correction:
  // response was non-substantive, treat as not-yet-replied).
  talent_responded: ['qualifying', 'contacted', 'not_in_consideration'],

  // Recruiter qualifying the talent. Forward to `qualified` (QUALIFY — the
  // affirmative milestone); back to talent_responded; or rejection.
  qualifying: ['qualified', 'talent_responded', 'not_in_consideration'],

  // The recruiter rests the episode at `qualified` — the last Pipeline-owned
  // state; the downstream Submittal / Client-Selection / Placement aggregates
  // advance independently. Back-correction to `qualifying`; rejection to
  // not_in_consideration. `qualified → completed` is legal ONLY so the system
  // COMPLETE command's precondition validates — it is NEVER offered as a
  // recruiter action (§5).
  qualified: ['qualifying', 'not_in_consideration', 'completed'],

  // Terminal states — no outgoing transitions.
  not_in_consideration: [],
  // the canonical SUCCESSFUL terminal (system-only COMPLETE, SB-3).
  completed: [],
  // administrative-correction terminal (VOID). No outgoing transitions and — by
  // design — NO INCOMING edge in this matrix: `no_contact → voided` is NOT a legal
  // generic transition. VOID is a named business command that owns the correction
  // (§9); the dedicated repository `void()` performs the write without consulting
  // this matrix, and the immutable episode is never reopened (§12).
  voided: [],
};

// EXPLICIT terminal partition. Both terminals have empty legal edges, so the
// partition is a hand-authored registry rather than a `length === 0` derivation.
export const CANONICAL_TERMINAL_STATUSES: readonly PipelineStatus[] = [
  'not_in_consideration',
  'completed',
  // VOID — administrative correction. Terminal + live-slot-releasing so a voided
  // (tenant,talent,requisition) episode frees the slot and the Talent may be added
  // again later as a fresh `no_contact` episode (§2/§12).
  'voided',
];

// The live-slot exclusion set. A status occupies the single live-episode slot
// iff it is NOT in this set — i.e. iff it is not terminal. The live-episode
// index migration duplicates this set as a literal SQL `NOT IN (...)` predicate
// (a migration cannot import this module); the B-index-parity drift guard holds
// the two equal.
export const LIVE_EPISODE_EXCLUSION_STATUSES: readonly PipelineStatus[] = [
  ...CANONICAL_TERMINAL_STATUSES,
];

// TERMINAL_STATUSES — "all terminals" (empty legal edges). Equals the live-slot
// exclusion set. Retained for callers that mean "has no outgoing transition".
export const TERMINAL_STATUSES: readonly PipelineStatus[] = PIPELINE_STATUS_VALUES.filter(
  (s) => LEGAL_TRANSITIONS[s].length === 0,
);

// isLive — a status occupies the single live-episode slot iff it is not terminal.
export function isLiveStatus(status: PipelineStatus): boolean {
  return !(LIVE_EPISODE_EXCLUSION_STATUSES as readonly string[]).includes(status);
}

/**
 * canTransition — the legal transition guard. Returns true iff the matrix
 * permits `from → to`. No-op (from === to) is treated as legal here so the
 * repository can early-return without an UPDATE; the "no-op guard" intercepts
 * this in the calling layer to avoid an empty history row.
 */
export function canTransition(
  from: PipelineStatus,
  to: PipelineStatus,
): boolean {
  if (from === to) return true;
  return LEGAL_TRANSITIONS[from].includes(to);
}

/**
 * legalNextStates — exposed for callers that want to enumerate the legal moves
 * from a given state (UI affordance, etc.). Not used by the transition path.
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

// Accidental-Add Correction — the governed VOID command. Deliberately NOT in
// RECRUITER_ACTION_TO_STATUS: VOID needs cross-domain engagement + downstream
// guards that the pipeline lib cannot compose (ADR-0029 wall), so it is orchestrated
// at apps/api and reaches the dedicated repository `void()` command — never the bare
// recruiter /actions or /transition surfaces. A body carrying this action on
// /actions is rejected (like COMPLETE).
export const VOID_ACTION = 'VOID' as const;

// The v1 reason vocabulary for VOID — closed, single-valued (§4). NOT a
// PipelineDisposition reason (§3: never `added_by_mistake` under
// not_in_consideration); it is carried on the void history row's `note`.
export const VOID_REASON_VALUES = ['ADDED_BY_MISTAKE'] as const;
export type VoidReason = (typeof VOID_REASON_VALUES)[number];
export function isVoidReason(v: unknown): v is VoidReason {
  return typeof v === 'string' && (VOID_REASON_VALUES as readonly string[]).includes(v);
}
