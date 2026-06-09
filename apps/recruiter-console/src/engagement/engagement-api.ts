import { apiClient } from '@aramo/fe-foundation';

import type {
  EngagementEventsResponse,
  EngagementListResponse,
  EngagementView,
  RecordConversationRequest,
  RecordConversationResponse,
  RecordResponseRequest,
  RecordResponseResponse,
  TransitionEngagementRequest,
  TransitionEngagementResponse,
} from './types';

// R7 engagement surface — the FE consumer of the engagement backend
// (PR#217 LIST + reads; the mutate endpoints from M5). NOTE the filter
// divergence confirmed at Gate-5: engagements filter on talent_id (NOT
// talent_record_id, which is the pipeline filter).
export async function listEngagementsForTalent(
  talentId: string,
): Promise<EngagementListResponse> {
  return apiClient.get<EngagementListResponse>(
    `/v1/engagements?talent_id=${encodeURIComponent(talentId)}`,
  );
}

export async function getEngagement(id: string): Promise<EngagementView> {
  return apiClient.get<EngagementView>(`/v1/engagements/${id}`);
}

export async function listEngagementEvents(
  id: string,
): Promise<EngagementEventsResponse> {
  return apiClient.get<EngagementEventsResponse>(
    `/v1/engagements/${id}/events`,
  );
}

// POST /v1/engagements/:id/transitions — body { to_state, event_id } +
// the Idempotency-Key header. Amendment v1.1 / RULING 1: the key (and the
// client event_id) are minted state-keyed by the caller — stable across a
// retry of ONE move, re-minted once the state advances. 422
// ENGAGEMENT_STATE_INVALID is surfaced via ApiError (the control only
// offers legalNextStates, so the refusal path is defense-in-depth).
export async function transitionEngagement(
  id: string,
  body: TransitionEngagementRequest,
  idempotencyKey: string,
): Promise<EngagementView> {
  const res = await apiClient.post<TransitionEngagementResponse>(
    `/v1/engagements/${id}/transitions`,
    body,
    { headers: { 'Idempotency-Key': idempotencyKey } },
  );
  return res.engagement;
}

// POST /v1/engagements/:id/response — RULING 3: outreach_event_ref_id
// references a prior outreach_sent event (the response picker). 422
// ENGAGEMENT_REFERENCE_NOT_FOUND if the ref doesn't resolve.
export async function recordResponse(
  id: string,
  body: RecordResponseRequest,
  idempotencyKey: string,
): Promise<RecordResponseResponse> {
  return apiClient.post<RecordResponseResponse>(
    `/v1/engagements/${id}/response`,
    body,
    { headers: { 'Idempotency-Key': idempotencyKey } },
  );
}

// POST /v1/engagements/:id/conversation — single conversation_started_at.
export async function recordConversation(
  id: string,
  body: RecordConversationRequest,
  idempotencyKey: string,
): Promise<RecordConversationResponse> {
  return apiClient.post<RecordConversationResponse>(
    `/v1/engagements/${id}/conversation`,
    body,
    { headers: { 'Idempotency-Key': idempotencyKey } },
  );
}
