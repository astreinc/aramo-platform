import { apiClient } from '@aramo/fe-foundation';

import type {
  CompanyMetrics,
  CompanyMetricsResponse,
  CompanyPlacementsResponse,
  CompanySearchPage,
  CompanyTeam,
} from './company-workspace';
import type {
  AddressAutocompleteResponse,
  AddressDetailsResponse,
  CompanyDepartmentListResponse,
  CompanyDepartmentView,
  CompanyListResponse,
  CompanyView,
  ContactListResponse,
  CreateCompanyDepartmentRequest,
  CreateCompanyRequest,
  UpdateCompanyRequest,
} from './types';

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

// Phase 2 — the server-side faceted page (GET /v1/companies?paged=true). Same
// route + gate as the list (company:read). Returns {items, next_cursor, facets,
// total}; the workspace builds `params` via buildCompanyQuery().
export async function searchCompanies(
  params: URLSearchParams,
): Promise<CompanySearchPage> {
  return apiClient.get<CompanySearchPage>(`/v1/companies?${params.toString()}`);
}

// Phase 3 — per-company metrics (open reqs / placements / submitted / fill-rate)
// via GET /v1/reports/company-metrics?company_ids=… (report:read). Best-effort:
// callers catch and degrade to "—" when the actor lacks report:read.
export async function getCompanyMetrics(
  companyIds: readonly string[],
): Promise<CompanyMetricsResponse> {
  if (companyIds.length === 0) return { items: [] };
  const params = new URLSearchParams({ company_ids: companyIds.join(',') });
  return apiClient.get<CompanyMetricsResponse>(
    `/v1/reports/company-metrics?${params.toString()}`,
  );
}

export async function getOneCompanyMetrics(
  companyId: string,
): Promise<CompanyMetrics | null> {
  const res = await getCompanyMetrics([companyId]);
  return res.items[0] ?? null;
}

// Phase 4 — the recruiter-readable account team (company:read) + the placed
// pipelines at the company's reqs (report:read). Both best-effort.
export async function getCompanyTeam(companyId: string): Promise<CompanyTeam> {
  return apiClient.get<CompanyTeam>(
    `/v1/companies/${encodeURIComponent(companyId)}/team`,
  );
}

export async function getCompanyPlacements(
  companyId: string,
): Promise<CompanyPlacementsResponse> {
  const params = new URLSearchParams({ company_id: companyId });
  return apiClient.get<CompanyPlacementsResponse>(
    `/v1/reports/company-placements?${params.toString()}`,
  );
}

// R3 — the company DETAIL endpoint. Same D4b visibility semantics as
// the list: invisible companies return 404 (not 403).
export async function getCompany(id: string): Promise<CompanyView> {
  return apiClient.get<CompanyView>(`/v1/companies/${encodeURIComponent(id)}`);
}

// R3 — the company Contacts tab. GET /v1/contacts accepts a company_id
// query filter (Gate-5 confirmed; libs/contact/src/lib/contact.controller
// .ts:38-56). Read-only in R3; add/edit lands with the company-mutate
// PR later.
export async function listContactsForCompany(
  companyId: string,
): Promise<ContactListResponse> {
  const params = new URLSearchParams({ company_id: companyId });
  return apiClient.get<ContactListResponse>(
    `/v1/contacts?${params.toString()}`,
  );
}

// R6' — company mutate. Both endpoints scope-gated server-side: POST
// requires company:create; PATCH requires company:edit. The recruiter
// role-bundle holds both (libs/identity/prisma/seed.ts ROLE_SCOPE_
// ASSIGNMENTS recruiter block — Gate-5 confirmed).
export async function createCompany(
  body: CreateCompanyRequest,
): Promise<CompanyView> {
  return apiClient.post<CompanyView>('/v1/companies', body);
}

export async function updateCompany(
  id: string,
  body: UpdateCompanyRequest,
): Promise<CompanyView> {
  return apiClient.patch<CompanyView>(
    `/v1/companies/${encodeURIComponent(id)}`,
    body,
  );
}

// Company-Fields v1.1 — the CompanyDepartment CRUD sub-routes (already built
// on the BE; surfaced in the EDIT form here). list (company:read) / create
// (company:create) / delete (company:delete) under /v1/companies/:id/departments.
export async function listCompanyDepartments(
  companyId: string,
): Promise<CompanyDepartmentListResponse> {
  return apiClient.get<CompanyDepartmentListResponse>(
    `/v1/companies/${encodeURIComponent(companyId)}/departments`,
  );
}

export async function createCompanyDepartment(
  companyId: string,
  body: CreateCompanyDepartmentRequest,
): Promise<CompanyDepartmentView> {
  return apiClient.post<CompanyDepartmentView>(
    `/v1/companies/${encodeURIComponent(companyId)}/departments`,
    body,
  );
}

export async function deleteCompanyDepartment(
  companyId: string,
  departmentId: string,
): Promise<void> {
  return apiClient.delete<void>(
    `/v1/companies/${encodeURIComponent(companyId)}/departments/${encodeURIComponent(departmentId)}`,
  );
}

// Address-Autocomplete v1.0 — the backend-proxied provider lookup. The Google
// (or other provider) key lives ONLY on the server; the browser calls these
// two routes (gated by company:create, same as company create). Both are
// NEVER-BLOCK on the server: a disabled feature or a provider failure returns
// an empty payload (200), so the caller falls back to manual address entry.
// Address-Autocomplete v1.1 — the OPTIONAL sessionToken threads autocomplete→
// details for one lookup so Google bills a single session. Omitted → unchanged.
export async function autocompleteAddress(
  query: string,
  sessionToken?: string,
): Promise<AddressAutocompleteResponse> {
  const params = new URLSearchParams({ query });
  if (sessionToken !== undefined && sessionToken !== '') {
    params.set('session_token', sessionToken);
  }
  return apiClient.get<AddressAutocompleteResponse>(
    `/v1/address-lookup/autocomplete?${params.toString()}`,
  );
}

export async function getAddressDetails(
  placeId: string,
  sessionToken?: string,
): Promise<AddressDetailsResponse> {
  const params = new URLSearchParams({ place_id: placeId });
  if (sessionToken !== undefined && sessionToken !== '') {
    params.set('session_token', sessionToken);
  }
  return apiClient.get<AddressDetailsResponse>(
    `/v1/address-lookup/details?${params.toString()}`,
  );
}
