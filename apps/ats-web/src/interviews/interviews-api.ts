import { apiClient } from '@aramo/fe-foundation';

// FE client for the interview CALENDAR read (GET /v1/interviews) and the authoritative
// interview DETAIL read (GET /v1/client-selection/interview-sessions/:id). Both are READ
// projections sourced from InterviewSession (the interview authority). Visibility +
// tenancy are server-side; the FE never sends a tenant/user/requisition id.

export type InterviewSessionState =
  | 'SCHEDULED'
  | 'RESCHEDULED'
  | 'COMPLETED'
  | 'CANCELED'
  | 'NO_SHOW';

export interface InterviewCalendarRow {
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
  readonly interviews: readonly InterviewCalendarRow[];
  readonly window: { readonly from: string; readonly to: string };
}

export interface InterviewCalendarQuery {
  readonly from: string;
  readonly to: string;
  readonly requisition_id?: string;
  readonly talent_id?: string;
  readonly interviewer_user_id?: string;
  readonly state?: InterviewSessionState;
}

export interface InterviewSessionDetail {
  readonly id: string;
  readonly tenant_id: string;
  readonly client_selection_process_id: string;
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly site_id: string | null;
  readonly interview_type: string;
  readonly round: number;
  readonly scheduled_at: string;
  readonly scheduled_end_at: string | null;
  readonly timezone: string | null;
  readonly interviewer_user_ids: readonly string[];
  readonly meeting_interaction_id: string | null;
  readonly state: InterviewSessionState;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export async function getInterviewCalendar(
  q: InterviewCalendarQuery,
): Promise<InterviewCalendarView> {
  const params = new URLSearchParams();
  params.set('from', q.from);
  params.set('to', q.to);
  if (q.requisition_id !== undefined) params.set('requisition_id', q.requisition_id);
  if (q.talent_id !== undefined) params.set('talent_id', q.talent_id);
  if (q.interviewer_user_id !== undefined)
    params.set('interviewer_user_id', q.interviewer_user_id);
  if (q.state !== undefined) params.set('state', q.state);
  return apiClient.get<InterviewCalendarView>(`/v1/interviews?${params.toString()}`);
}

export async function getInterviewSession(
  sessionId: string,
): Promise<InterviewSessionDetail> {
  return apiClient.get<InterviewSessionDetail>(
    `/v1/client-selection/interview-sessions/${encodeURIComponent(sessionId)}`,
  );
}

// Slice B — write clients. Schedule creates a new InterviewSession under a
// client-selection process (Idempotency-Key required, mirrors the pipeline precedent);
// transition drives the versioned lifecycle (reschedule/cancel/complete/no-show). Both
// return the authoritative InterviewSession. Neither is an FE state machine — the backend
// remains authoritative; the FE only renders permissible actions and echoes the version.
export interface ScheduleInterviewBody {
  readonly interview_type: string;
  readonly round?: number;
  readonly scheduled_at: string;
  readonly scheduled_end_at?: string;
  readonly timezone?: string;
  readonly interviewer_user_ids?: readonly string[];
}

export async function scheduleInterview(
  clientSelectionProcessId: string,
  body: ScheduleInterviewBody,
): Promise<InterviewSessionDetail> {
  return apiClient.post<InterviewSessionDetail>(
    `/v1/client-selection/${encodeURIComponent(clientSelectionProcessId)}/interviews`,
    body,
    { headers: { 'Idempotency-Key': crypto.randomUUID() } },
  );
}

export interface TransitionInterviewBody {
  readonly to_state: InterviewSessionState;
  readonly expected_version: number;
  readonly scheduled_at?: string;
  readonly scheduled_end_at?: string;
  readonly timezone?: string;
  readonly note?: string;
}

export async function transitionInterview(
  sessionId: string,
  body: TransitionInterviewBody,
): Promise<InterviewSessionDetail> {
  return apiClient.post<InterviewSessionDetail>(
    `/v1/client-selection/interview-sessions/${encodeURIComponent(sessionId)}/transition`,
    body,
  );
}

// Slice C (§14) — associate a provider-neutral meeting interaction (CAS on version).
export async function associateInterviewMeeting(
  sessionId: string,
  body: { readonly expected_version: number; readonly meeting_interaction_id: string },
): Promise<InterviewSessionDetail> {
  return apiClient.post<InterviewSessionDetail>(
    `/v1/client-selection/interview-sessions/${encodeURIComponent(sessionId)}/meeting`,
    body,
  );
}

// Slice C (§10) — replace the interviewer panel on a non-terminal session (CAS on version).
export async function updateInterviewInterviewers(
  sessionId: string,
  body: { readonly expected_version: number; readonly interviewer_user_ids: readonly string[] },
): Promise<InterviewSessionDetail> {
  return apiClient.patch<InterviewSessionDetail>(
    `/v1/client-selection/interview-sessions/${encodeURIComponent(sessionId)}/interviewers`,
    body,
  );
}

// Slice C (§21) — qualitative interview feedback, tied to the interview via the EXISTING
// activity substrate (subject_type='interview_session'). NO second feedback truth store,
// NO rating/ordinal-judgment (§20) — free-text notes only.
export interface InterviewFeedbackNote {
  readonly id: string;
  readonly notes: string | null;
  readonly created_by_id: string | null;
  readonly created_at: string;
  readonly redacted_at: string | null;
}

export async function listInterviewFeedback(
  sessionId: string,
): Promise<readonly InterviewFeedbackNote[]> {
  const params = new URLSearchParams({
    subject_type: 'interview_session',
    subject_id: sessionId,
  });
  const res = await apiClient.get<{ items?: readonly InterviewFeedbackNote[] }>(
    `/v1/activities?${params.toString()}`,
  );
  return res.items ?? [];
}

export async function addInterviewFeedback(
  sessionId: string,
  notes: string,
): Promise<void> {
  await apiClient.post('/v1/activities', {
    type: 'note',
    subject_type: 'interview_session',
    subject_id: sessionId,
    notes,
    category: 'INTERVIEW_FEEDBACK',
  });
}

// True when an error is the optimistic-concurrency conflict (stale version) — the FE
// surfaces the "someone changed this interview" refresh prompt rather than overwriting.
export function isTransitionConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; status?: unknown; statusCode?: unknown };
  return (
    e.code === 'INTERVIEW_SESSION_TRANSITION_CONFLICT' ||
    e.status === 409 ||
    e.statusCode === 409
  );
}
