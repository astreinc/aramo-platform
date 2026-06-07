import { apiClient } from '@aramo/fe-foundation';

import type { RequisitionListResponse, RequisitionView } from './types';

// Visibility is applied at the BE (D4b lazy resolver). The recruiter
// sees only assigned-or-client-visible reqs; invisible → 404. R1 calls
// these endpoints raw — the active/closed split happens FE-side over
// the visibility-scoped result set.

export async function listRequisitions(): Promise<RequisitionListResponse> {
  return apiClient.get<RequisitionListResponse>('/v1/requisitions');
}

export async function getRequisition(id: string): Promise<RequisitionView> {
  return apiClient.get<RequisitionView>(`/v1/requisitions/${id}`);
}
