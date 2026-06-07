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
