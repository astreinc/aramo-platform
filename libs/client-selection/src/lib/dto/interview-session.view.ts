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
  readonly interviewer_user_ids: readonly string[];
  readonly state: InterviewSessionState;
  // Optimistic-concurrency token; echo back as expected_version on the next transition.
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}
