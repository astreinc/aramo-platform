import { apiClient } from '@aramo/fe-foundation';

import type {
  PipelineActionRequest,
  PipelineHistoryResponse,
  PipelineListResponse,
  PipelineResumeEditionView,
  PipelineView,
  SetPipelineResumeEditionRequest,
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

// Add a talent to a requisition's pipeline (pipeline:add). POST /v1/pipelines
// creates the row at the hard-coded initial status (no_contact) — the body
// carries only the link (libs/pipeline create-pipeline-request.dto.ts). Used by
// the Talent workspace "Add to req" row/bulk action.
export async function addTalentToPipeline(
  talentRecordId: string,
  requisitionId: string,
): Promise<PipelineView> {
  // L2-B — POST /v1/pipelines now requires a UUID Idempotency-Key. This is a
  // one-shot action, so a per-call key is sufficient (mirrors the submittals /
  // selection create surfaces); a retry with a fresh key is a fresh command,
  // and a genuine duplicate live episode is refused server-side (409).
  return apiClient.post<PipelineView>(
    '/v1/pipelines',
    {
      talent_record_id: talentRecordId,
      requisition_id: requisitionId,
    },
    { headers: { 'Idempotency-Key': crypto.randomUUID() } },
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

// L2-C — the recruiter named-action surface (POST /v1/pipelines/{id}/actions,
// pipeline:change-status). A thin echo of transitionPipeline for the named
// commands (CONTACT / MARK_RESPONDED / START_QUALIFICATION / QUALIFY /
// DISPOSITION); the server maps the action to its to_status and, for DISPOSITION,
// writes the authority-partitioned reason in the terminal transaction. COMPLETE is
// NOT reachable here (system-only — a body carrying it is refused 422).
export async function applyPipelineAction(
  pipelineId: string,
  body: PipelineActionRequest,
): Promise<PipelineView> {
  return apiClient.post<PipelineView>(
    `/v1/pipelines/${pipelineId}/actions`,
    body,
  );
}

// Accidental-Add Correction — "Remove from requisition" (VOID). A governed
// correction, NOT a recruiting disposition and NOT a delete. The backend is
// authoritative: it re-checks no_contact + no engagement + no downstream and
// returns a typed refusal (PIPELINE_VOID_*) when ineligible. CAS via
// expected_version. On success the episode becomes terminal `voided`.
export async function voidPipelineEpisode(
  pipelineId: string,
  body: { reason: 'ADDED_BY_MISTAKE'; expected_version: number },
): Promise<PipelineView> {
  return apiClient.post<PipelineView>(`/v1/pipelines/${pipelineId}/void`, body);
}

// Kanban card-name lookup. R1 fetches per visible pipeline in parallel
// (Promise.all); see ./types.ts TalentRecordSummary for the carry note.
export async function getTalentRecord(id: string): Promise<TalentRecordSummary> {
  return apiClient.get<TalentRecordSummary>(`/v1/talent-records/${id}`);
}

// TI-1D-D — the Requisition-context résumé selection for a pipeline (pipeline:read).
// Returns the explicit working selection (null when never selected), the
// Talent-global default (a suggestion only), and the active editions eligible for
// a new selection.
export async function getPipelineResumeEdition(
  pipelineId: string,
): Promise<PipelineResumeEditionView> {
  return apiClient.get<PipelineResumeEditionView>(
    `/v1/pipelines/${pipelineId}/resume-edition`,
  );
}

// TI-1D-D — explicitly select the résumé edition for this Talent × requisition
// (pipeline:resume:set). Appends a new append-only working-selection row; never
// mutates a prior selection and never binds at send. Returns the updated view.
export async function setPipelineResumeEdition(
  pipelineId: string,
  body: SetPipelineResumeEditionRequest,
): Promise<PipelineResumeEditionView> {
  return apiClient.put<PipelineResumeEditionView>(
    `/v1/pipelines/${pipelineId}/resume-edition`,
    body,
  );
}
