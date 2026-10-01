import type { InterviewSessionState } from '../interview-session-state.js';

// POST body to schedule an InterviewSession under a ClientSelectionProcess (:id in the
// path). Participants are store-only identity.User UUID refs (unvalidated at F2).
export interface ScheduleInterviewRequestDto {
  readonly interview_type: string;
  readonly round?: number;
  readonly scheduled_at: string;
  // Slice B — optional authoritative end instant + IANA display/input zone.
  // scheduled_end_at, when supplied, MUST be after scheduled_at.
  readonly scheduled_end_at?: string;
  readonly timezone?: string;
  readonly interviewer_user_ids?: readonly string[];
}

// POST body for an InterviewSession state transition. `expected_version` is the
// optimistic-concurrency token the caller last read; a stale value is refused with
// INTERVIEW_SESSION_TRANSITION_CONFLICT (409). `scheduled_at` is REQUIRED when
// `to_state` is RESCHEDULED (the new time) and ignored otherwise.
export interface TransitionInterviewSessionRequestDto {
  readonly to_state: InterviewSessionState;
  readonly expected_version: number;
  readonly scheduled_at?: string;
  // Slice B — on a RESCHEDULED transition the caller may set a new end instant + zone
  // alongside scheduled_at. Ignored for non-RESCHEDULED transitions. scheduled_end_at,
  // when supplied, MUST be after the effective scheduled_at.
  readonly scheduled_end_at?: string;
  readonly timezone?: string;
  readonly note?: string;
}

// Slice C (§14) — associate a provider-neutral meeting interaction to a session. CAS on
// expected_version. NEVER changes lifecycle state.
export interface AssociateMeetingRequestDto {
  readonly expected_version: number;
  readonly meeting_interaction_id: string;
}

// Slice C (§10) — replace the interviewer panel (non-terminal sessions). CAS on
// expected_version; each id is validated as a current tenant user at the boundary.
export interface UpdateInterviewersRequestDto {
  readonly expected_version: number;
  readonly interviewer_user_ids: readonly string[];
}
