import type { InterviewSessionState } from '../interview-session-state.js';

// The projected InterviewSession (the controller returns this shape).
export interface InterviewSessionView {
  readonly id: string;
  readonly tenant_id: string;
  readonly client_selection_process_id: string;
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly site_id: string | null;
  readonly interview_type: string;
  readonly round: number;
  readonly scheduled_at: string;
  // Slice B — authoritative end instant (nullable for legacy rows, never fabricated) +
  // IANA display/input zone (nullable for legacy rows).
  readonly scheduled_end_at: string | null;
  readonly timezone: string | null;
  readonly interviewer_user_ids: readonly string[];
  // Slice C — provider-neutral association to a communications meeting interaction
  // (null when no meeting is linked). The join link itself lives in Communications.
  readonly meeting_interaction_id: string | null;
  readonly state: InterviewSessionState;
  // Optimistic-concurrency token; echo back as expected_version on the next transition.
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}
