import { apiClient } from '@aramo/fe-foundation';

import type {
  CreateRequisitionRequest,
  RequisitionListResponse,
  RequisitionView,
  UpdateRequisitionRequest,
} from './types';

// Visibility is applied at the BE (D4b lazy resolver). The recruiter
// sees only assigned-or-client-visible reqs; invisible → 404. R1 calls
// these endpoints raw — the active/closed split happens FE-side over
// the visibility-scoped result set.
//
// The optional company_id arg is the company-detail consumer (the
// requisitions-by-company FE follow-on). The server ANDs company_id
// with the A3/D4b visibility predicate — no client-side filter, no
// truncation banner.
export async function listRequisitions(
  params?: { company_id?: string },
): Promise<RequisitionListResponse> {
  const companyId = params?.company_id;
  if (companyId === undefined || companyId === '') {
    return apiClient.get<RequisitionListResponse>('/v1/requisitions');
  }
  const search = new URLSearchParams({ company_id: companyId });
  return apiClient.get<RequisitionListResponse>(
    `/v1/requisitions?${search.toString()}`,
  );
}

export async function getRequisition(id: string): Promise<RequisitionView> {
  return apiClient.get<RequisitionView>(`/v1/requisitions/${id}`);
}

// R4 — mutate-side: CREATE (POST) + EDIT (PATCH).
//
// Both return the resulting RequisitionView (the BE applies the D5 read
// mask before returning, so a no-view:pay caller never sees compensation
// fields in the response — even if they were just sent on POST).
//
// The form's D5-DEFENSIVE policy (ruling 1) is enforced at the CALLER
// (RequisitionForm) — it OMITS comp fields the recruiter can't see;
// these api functions just send what they're given.

export async function createRequisition(
  body: CreateRequisitionRequest,
): Promise<RequisitionView> {
  return apiClient.post<RequisitionView>('/v1/requisitions', body);
}

export async function updateRequisition(
  id: string,
  body: UpdateRequisitionRequest,
): Promise<RequisitionView> {
  return apiClient.patch<RequisitionView>(
    `/v1/requisitions/${encodeURIComponent(id)}`,
    body,
  );
}
