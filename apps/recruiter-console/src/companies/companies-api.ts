import { apiClient } from '@aramo/fe-foundation';

import type { CompanyListResponse } from './types';

// The companies LIST is the D4b-VISIBILITY-RESOLVED surface: the BE
// scopes rows via libs/visibility (direct ∪ transitive-reports[depth≤3]
// ∪ pod-clients ∪ [ALL if company:read:all]). The recruiter receives
// only their visible clients — narrower than tenant-wide. The framing
// in the view reflects that honestly; a visible-only LIST is correct
// behavior (NOT a workflow gap requiring a limitation note — unlike
// the S5c-3 company picker, where invisible-company assignment was
// a real surface).

export async function listCompanies(): Promise<CompanyListResponse> {
  return apiClient.get<CompanyListResponse>('/v1/companies');
}
