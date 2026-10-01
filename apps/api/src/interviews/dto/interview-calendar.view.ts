import type { InterviewSessionState } from '@aramo/client-selection';

// The enriched interview CALENDAR row (Slice A, Calendar/Interview §6). Sourced from
// InterviewSession (the interview authority, NEVER CalendarEvent) and enriched
// server-side with Talent / Requisition / company display so the FE renders the
// calendar without N+1 reads. Columns deferred to later slices are intentionally
// ABSENT here rather than faked: scheduled_end_at + duration (Slice B) and the meeting
// link state (Slice C). `version` is echoed so the FE can drive a transition CAS.
export interface InterviewCalendarRowView {
  readonly id: string;
  readonly scheduled_at: string;
  readonly scheduled_end_at: string | null;
  readonly timezone: string | null;
  readonly state: InterviewSessionState;
  readonly round: number;
  readonly interview_type: string;
  readonly talent_record_id: string;
  readonly talent_name: string | null;
  readonly requisition_id: string;
  readonly requisition_number: number | null;
  readonly requisition_title: string | null;
  readonly company_id: string | null;
  readonly company_name: string | null;
  readonly interviewer_user_ids: readonly string[];
  readonly version: number;
}

export interface InterviewCalendarView {
  readonly interviews: readonly InterviewCalendarRowView[];
  readonly window: { readonly from: string; readonly to: string };
}
