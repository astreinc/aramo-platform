import { apiClient } from '@aramo/fe-foundation';

import type {
  CreateSubmittalRequest,
  EvidencePackageView,
  MatchListResponse,
  RecruiterAttestations,
  SubmittalLookupResponse,
  SubmittalResponse,
  SubmittalRevokeResponse,
} from './types';

// R6 — the recruiter submittal wizard's API surface. The 8 endpoints +
// the discovery lookup + the match-list lookup (the FE's path to the
// examination_id). Every mutating POST mints an Idempotency-Key (UUIDv4)
// minted once per business-intent action; the caller passes it in so the
// same key replays on transient retries of the SAME body.

// PHASE-B-CARRY (T1) — the de-facto single-backend identity convention.
// We pass the visible requisition's id as `job_id` under the shared-UUID
// assumption: submittal.job_id aliases requisition.Requisition.id ==
// examination.job_id (the substrate enforces this equality at
// evidence.buildPackage Step 2 + the visibility cascade filters submittal
// by job_id IN visible_requisition_ids). When the Core/ATS boundary is
// honored, the wizard must call a real id-bridge here to translate the
// recruiter-visible requisition_id into the corresponding Core job_id.
// See Aramo-Carry-T1-Identity-Bridge-and-ATS-Score-Store-Phase-B.md.

export async function createSubmittal(
  body: CreateSubmittalRequest,
  idempotencyKey: string,
): Promise<SubmittalResponse> {
  return apiClient.post<SubmittalResponse>('/v1/submittals', body, {
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}

export async function findSubmittalForTalentJob(
  talentId: string,
  jobId: string,
): Promise<SubmittalLookupResponse> {
  return apiClient.get<SubmittalLookupResponse>(
    `/v1/submittals?talent_id=${encodeURIComponent(talentId)}&job_id=${encodeURIComponent(jobId)}`,
  );
}

export async function getSubmittal(
  id: string,
): Promise<{ submittal: SubmittalResponse['submittal'] }> {
  // GET /v1/submittals/{id} returns the View directly (no wrapper) per
  // the M4 PR-6 controller shape. We re-wrap for consumer uniformity.
  const view = await apiClient.get<SubmittalResponse['submittal']>(
    `/v1/submittals/${id}`,
  );
  return { submittal: view };
}

export async function getEvidencePackage(
  submittalId: string,
): Promise<EvidencePackageView> {
  return apiClient.get<EvidencePackageView>(
    `/v1/submittals/${submittalId}/evidence-package`,
  );
}

export async function markReady(
  submittalId: string,
  idempotencyKey: string,
): Promise<SubmittalResponse> {
  return apiClient.post<SubmittalResponse>(
    `/v1/submittals/${submittalId}/mark-ready`,
    {},
    { headers: { 'Idempotency-Key': idempotencyKey } },
  );
}

export async function submitToAts(
  submittalId: string,
  idempotencyKey: string,
): Promise<SubmittalResponse> {
  return apiClient.post<SubmittalResponse>(
    `/v1/submittals/${submittalId}/submit-to-ats`,
    {},
    { headers: { 'Idempotency-Key': idempotencyKey } },
  );
}

export async function confirmSubmittal(
  submittalId: string,
  attestations: RecruiterAttestations,
  idempotencyKey: string,
): Promise<SubmittalResponse> {
  return apiClient.post<SubmittalResponse>(
    `/v1/submittals/${submittalId}/confirm`,
    { attestations },
    { headers: { 'Idempotency-Key': idempotencyKey } },
  );
}

export async function confirmAts(
  submittalId: string,
  idempotencyKey: string,
): Promise<SubmittalResponse> {
  return apiClient.post<SubmittalResponse>(
    `/v1/submittals/${submittalId}/confirm-ats`,
    {},
    { headers: { 'Idempotency-Key': idempotencyKey } },
  );
}

export async function revokeSubmittal(
  submittalId: string,
  revocationJustification: string,
  idempotencyKey: string,
): Promise<SubmittalRevokeResponse> {
  return apiClient.post<SubmittalRevokeResponse>(
    `/v1/submittals/${submittalId}/revoke`,
    { revocation_justification: revocationJustification },
    { headers: { 'Idempotency-Key': idempotencyKey } },
  );
}

// Match-list lookup — the FE's path to the examination_id for a
// (talent, requisition) pair. We pass requisition_id as job_id under the
// PHASE-B-CARRY (T1) convention above and filter the returned summaries
// by talent_id client-side.
export async function findMatchesForRequisition(
  requisitionId: string,
): Promise<MatchListResponse> {
  return apiClient.get<MatchListResponse>(
    `/v1/jobs/${encodeURIComponent(requisitionId)}/matches`,
  );
}
