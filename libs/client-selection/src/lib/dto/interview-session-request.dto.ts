import type { InterviewSessionState } from '../interview-session-state.js';

// POST body to schedule an InterviewSession under a ClientSelectionProcess (:id in the
// path). Participants are store-only identity.User UUID refs (unvalidated at F2).
export interface ScheduleInterviewRequestDto {
  readonly interview_type: string;
  readonly round?: number;
  readonly scheduled_at: string;
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
  readonly note?: string;
}
