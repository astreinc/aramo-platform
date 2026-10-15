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
  created_at: string;
  updated_at: string;
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

export async function createScreeningSession(talentId: string): Promise<ScreeningSession> {
  return apiClient.post<ScreeningSession>(sessionsPath(talentId), {});
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
