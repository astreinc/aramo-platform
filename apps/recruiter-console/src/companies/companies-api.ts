import { apiClient } from '@aramo/fe-foundation';

import type {
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
