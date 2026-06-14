import { apiClient } from '@aramo/fe-foundation';

import type {
  PipelineHistoryResponse,
  PipelineListResponse,
  PipelineView,
  TalentRecordSummary,
  TransitionPipelineRequest,
} from './types';

export async function listPipelinesForRequisition(
  requisitionId: string,
): Promise<PipelineListResponse> {
  return apiClient.get<PipelineListResponse>(
    `/v1/pipelines?requisition_id=${encodeURIComponent(requisitionId)}`,
  );
}

// Unfiltered list — returns EVERY pipeline across the actor's visible
// requisitions in one call (libs/pipeline/src/lib/pipeline.controller.ts:54-74:
// no requisition/talent filter → listForActor over visible_requisition_ids).
// The Requisitions list groups this by requisition_id for per-req
// Pipeline/Submitted counts — one call, not N+1.
export async function listAllPipelines(): Promise<PipelineListResponse> {
  return apiClient.get<PipelineListResponse>('/v1/pipelines');
}

// R3 — the talent DETAIL Pipelines tab. The Gate-5 KEY confirmation:
// /v1/pipelines accepts a talent_record_id filter (libs/pipeline/src/
// lib/pipeline.controller.ts:54-74, line 61). Fully supported.
export async function listPipelinesForTalent(
  talentId: string,
): Promise<PipelineListResponse> {
  return apiClient.get<PipelineListResponse>(
    `/v1/pipelines?talent_record_id=${encodeURIComponent(talentId)}`,
  );
}

export async function getPipelineHistory(
  pipelineId: string,
): Promise<PipelineHistoryResponse> {
  return apiClient.get<PipelineHistoryResponse>(
    `/v1/pipelines/${pipelineId}/history`,
  );
}

// 422 INVALID_PIPELINE_TRANSITION is surfaced via foundation ApiError
// (code + details). The "Move to…" menu only offers legalNextStates so
// the recruiter can't pick an illegal target — this BE refusal path is
// defense-in-depth (the matrix is the source of truth; the FE mirror
// could drift in a race window between merges).
export async function transitionPipeline(
  pipelineId: string,
  body: TransitionPipelineRequest,
): Promise<PipelineView> {
  return apiClient.post<PipelineView>(
    `/v1/pipelines/${pipelineId}/transition`,
    body,
  );
}

// Kanban card-name lookup. R1 fetches per visible pipeline in parallel
// (Promise.all); see ./types.ts TalentRecordSummary for the carry note.
export async function getTalentRecord(id: string): Promise<TalentRecordSummary> {
  return apiClient.get<TalentRecordSummary>(`/v1/talent-records/${id}`);
}
