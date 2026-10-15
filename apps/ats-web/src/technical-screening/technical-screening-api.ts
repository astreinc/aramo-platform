import { apiClient } from '@aramo/fe-foundation';

// TIP-E2E INC-3 — Manual Technical Screening client (ARAMO-TIP-E2E-INC-3-v1.0-LOCKED §9/§11).
// Tenancy, actor, site visibility and every lifecycle rule are server-side; the
// FE sends only ids, the session version (CAS) and the recruiter's own input.

export type ScreeningBasis = 'SELF_REPORTED' | 'RECRUITER_OBSERVED' | 'DEMONSTRATED';
export type ScreeningSessionState = 'DRAFT' | 'CONFIRMED' | 'VOIDED';
export type ScreeningPublicationState = 'PENDING' | 'PUBLISHED' | 'CONFLICT';

export interface ScreeningSession {
  id: string;
  talent_record_id: string;
  interaction_id: string | null;
  requisition_id: string | null;
  state: ScreeningSessionState;
  version: number;
  created_at: string;
  updated_at: string;
  created_by_actor_id: string;
  confirmed_by_actor_id: string | null;
  confirmed_at: string | null;
  confirmed_version: number | null;
  voided_by_actor_id: string | null;
  voided_at: string | null;
  void_reason: string | null;
}

export interface ScreeningFinding {
  id: string;
  skill_raw: string;
  basis: ScreeningBasis;
  observation_raw: string;
  demonstration_raw: string | null;
  limitations_raw: string | null;
  // INC-3 A1 §B.2 — the three provenance axes. ai_original keeps the AI text
  // beside any recruiter edit.
  origin: ScreeningFindingOrigin;
  review_status: ScreeningReviewStatus | null;
  evidence_source: ScreeningEvidenceSource;
  ai_original: { skill_raw?: string; observation_raw?: string; limitations_raw?: string | null } | null;
  reviewed_by_actor_id: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type ScreeningFindingOrigin = 'RECRUITER_AUTHORED' | 'AI_DRAFTED';
export type ScreeningReviewStatus = 'DRAFT' | 'EDITED' | 'CONFIRMED' | 'REJECTED';
export type ScreeningEvidenceSource = 'RECRUITER_OBSERVATION' | 'MEETING_TRANSCRIPT' | 'RECRUITER_NOTES';

export interface ScreeningCitation {
  id: string;
  finding_id: string;
  conversation_transcript_id: string;
  utterance_id: string;
  start_offset: number;
  end_offset: number;
}

export interface ScreeningQuestion {
  id: string;
  text: string;
  skill_ref: string | null;
  intent: 'PROBE' | 'FOLLOW_UP';
  origin: 'AI_GENERATED' | 'RECRUITER_AUTHORED';
  status: 'PROPOSED' | 'SELECTED' | 'REMOVED';
  edited: boolean;
  position: number;
  generation_id: string | null;
}

export interface ScreeningNote {
  id: string;
  body: string;
  created_at: string;
}

export interface ScreeningSuggestion {
  id: string;
  generation_id: string;
  text: string;
  trigger_kind: 'NOTE' | 'TRANSCRIPT_SEGMENTS';
  trigger_ref: unknown;
  action: 'USED' | 'DISMISSED' | null;
  created_at: string;
}

export interface ScreeningGeneration {
  id: string;
  kind: 'QUESTION_PLAN' | 'FOLLOW_UP' | 'FINDINGS_DRAFT';
  provider: string;
  model: string;
  used_talent_profile: boolean;
  used_requisition: boolean;
  used_transcript: boolean;
  created_at: string;
}

export interface ScreeningTranscriptLink {
  conversation_transcript_id: string;
  source: 'TEAMS_GRAPH' | 'EXTERNAL_PROVIDER';
  created_at: string;
}

export interface ScreeningAnalysis {
  run_id: string;
  conversation_transcript_id: string;
  status: string;
  last_error_code: string | null;
  model_provider: string;
  model_name: string;
  created_at: string;
  completed_at: string | null;
}

export type CaptureModeStatus = 'available' | 'not_granted' | 'not_connected' | 'reauth_required' | 'no_approved_provider';

export interface ScreeningCaptureModes {
  recruiter_notes: { status: 'available' };
  teams_post_meeting: { status: CaptureModeStatus };
  live_external_provider: { status: 'no_approved_provider' };
}

export interface ScreeningTranscriptCheckItem {
  conversation_transcript_id: string;
  provider_transcript_id: string;
  state: string;
  linked: boolean;
  analysis: string | null;
}

export interface ScreeningMeetingResult {
  interaction_id: string;
  join_url: string | null;
  idempotent_replay: boolean;
  artifact_preparation: string;
  record_automatically: boolean;
}

export interface ScreeningCitationExcerpt {
  citation_id: string;
  conversation_transcript_id: string;
  utterance_id: string;
  speaker_role: string;
  excerpt: string;
  utterance_text: string;
}

export interface ScreeningPublication {
  id: string;
  finding_id: string;
  evidence_record_id: string;
  state: ScreeningPublicationState;
  attempt_count: number;
  last_attempt_at: string | null;
  last_error_code: string | null;
  published_at: string | null;
  created_at: string;
  trust_status: string | null;
}

export interface ScreeningSessionDetail {
  session: ScreeningSession;
  findings: ScreeningFinding[];
  publications: ScreeningPublication[];
  citations: ScreeningCitation[];
  questions: ScreeningQuestion[];
  notes: ScreeningNote[];
  suggestions: ScreeningSuggestion[];
  generations: ScreeningGeneration[];
  transcripts: ScreeningTranscriptLink[];
  analyses: ScreeningAnalysis[];
}

export interface ScreeningFindingInput {
  skill_raw: string;
  basis: ScreeningBasis;
  observation_raw: string;
  demonstration_raw?: string | null;
  limitations_raw?: string | null;
}

const sessionsPath = (talentId: string): string => `/v1/talent-records/${talentId}/screening-sessions`;
const sessionPath = (id: string): string => `/v1/screening-sessions/${id}`;

export async function listScreeningSessions(talentId: string): Promise<{ items: ScreeningSession[] }> {
  return apiClient.get<{ items: ScreeningSession[] }>(sessionsPath(talentId));
}

// INC-3 A1 — the Requisition is optional; it tailors the question plan only.
export async function createScreeningSession(talentId: string, requisitionId?: string | null): Promise<ScreeningSession> {
  return apiClient.post<ScreeningSession>(
    sessionsPath(talentId),
    requisitionId !== undefined && requisitionId !== null ? { requisition_id: requisitionId } : {},
  );
}

export async function getScreeningSession(id: string): Promise<ScreeningSessionDetail> {
  return apiClient.get<ScreeningSessionDetail>(sessionPath(id));
}

export async function addScreeningFinding(
  id: string,
  version: number,
  input: ScreeningFindingInput,
): Promise<ScreeningSessionDetail> {
  return apiClient.post<ScreeningSessionDetail>(`${sessionPath(id)}/findings`, { version, ...input });
}

export async function editScreeningFinding(
  id: string,
  findingId: string,
  version: number,
  input: ScreeningFindingInput,
): Promise<ScreeningSessionDetail> {
  return apiClient.patch<ScreeningSessionDetail>(`${sessionPath(id)}/findings/${findingId}`, { version, ...input });
}

export async function removeScreeningFinding(
  id: string,
  findingId: string,
  version: number,
): Promise<ScreeningSessionDetail> {
  return apiClient.delete<ScreeningSessionDetail>(
    `${sessionPath(id)}/findings/${findingId}?version=${encodeURIComponent(String(version))}`,
  );
}

// A fresh Idempotency-Key per user action makes a retried request a replay.
export async function confirmScreeningSession(
  id: string,
  version: number,
  findingIds: string[],
): Promise<ScreeningSessionDetail> {
  return apiClient.post<ScreeningSessionDetail>(
    `${sessionPath(id)}/confirm`,
    { version, confirmed_finding_ids: findingIds, observations_confirmed: true },
    { headers: { 'Idempotency-Key': crypto.randomUUID() } },
  );
}

export async function voidScreeningSession(id: string, version: number, reason: string | null): Promise<ScreeningSessionDetail> {
  return apiClient.post<ScreeningSessionDetail>(`${sessionPath(id)}/void`, { version, reason });
}

export async function retryScreeningPublication(id: string): Promise<ScreeningSessionDetail> {
  return apiClient.post<ScreeningSessionDetail>(`${sessionPath(id)}/publish`, undefined, {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  });
}

// ---- INC-3 A1 — AI-assisted screening -----------------------------------

export async function generateScreeningQuestions(id: string, includeTalentProfile: boolean): Promise<ScreeningSessionDetail> {
  return apiClient.post<ScreeningSessionDetail>(`${sessionPath(id)}/questions/generate`, {
    include_talent_profile: includeTalentProfile,
  });
}

export async function addScreeningQuestion(id: string, text: string): Promise<ScreeningSessionDetail> {
  return apiClient.post<ScreeningSessionDetail>(`${sessionPath(id)}/questions`, { text });
}

export async function updateScreeningQuestion(
  id: string,
  questionId: string,
  patch: { text?: string; status?: ScreeningQuestion['status'] },
): Promise<ScreeningSessionDetail> {
  return apiClient.patch<ScreeningSessionDetail>(`${sessionPath(id)}/questions/${questionId}`, patch);
}

export async function addScreeningNote(id: string, body: string): Promise<ScreeningSessionDetail> {
  return apiClient.post<ScreeningSessionDetail>(`${sessionPath(id)}/notes`, { body });
}

export async function requestScreeningSuggestions(id: string, noteId: string): Promise<ScreeningSessionDetail> {
  return apiClient.post<ScreeningSessionDetail>(`${sessionPath(id)}/suggestions`, { note_id: noteId });
}

export async function actionScreeningSuggestion(
  id: string,
  suggestionId: string,
  action: 'USED' | 'DISMISSED',
): Promise<ScreeningSessionDetail> {
  return apiClient.patch<ScreeningSessionDetail>(`${sessionPath(id)}/suggestions/${suggestionId}`, { action });
}

export async function reviewScreeningFinding(
  id: string,
  findingId: string,
  version: number,
  outcome: 'CONFIRMED' | 'REJECTED',
): Promise<ScreeningSessionDetail> {
  return apiClient.post<ScreeningSessionDetail>(`${sessionPath(id)}/findings/${findingId}/review`, { version, outcome });
}

export async function getScreeningCaptureModes(id: string): Promise<ScreeningCaptureModes> {
  return apiClient.get<ScreeningCaptureModes>(`${sessionPath(id)}/capture-modes`);
}

// A fresh idempotency key per user action: a retried request replays the same
// Outlook operation instead of creating a second meeting.
export async function scheduleScreeningMeeting(
  id: string,
  slot: { subject: string; start_date_time: string; end_date_time: string; time_zone: string },
): Promise<{ meeting: ScreeningMeetingResult; session: ScreeningSessionDetail }> {
  return apiClient.post<{ meeting: ScreeningMeetingResult; session: ScreeningSessionDetail }>(`${sessionPath(id)}/meeting`, {
    ...slot,
    idempotency_key: crypto.randomUUID(),
  });
}

export async function checkScreeningTranscripts(
  id: string,
): Promise<{ items: ScreeningTranscriptCheckItem[]; session: ScreeningSessionDetail }> {
  return apiClient.post<{ items: ScreeningTranscriptCheckItem[]; session: ScreeningSessionDetail }>(
    `${sessionPath(id)}/transcripts/check`,
    {},
  );
}

export async function getScreeningCitationExcerpt(id: string, citationId: string): Promise<ScreeningCitationExcerpt> {
  return apiClient.get<ScreeningCitationExcerpt>(`${sessionPath(id)}/citations/${citationId}/excerpt`);
}
