import { apiClient } from '@aramo/fe-foundation';

import type { ContactView } from '../companies/types';

import type { ContactSearchPage } from './contact-workspace';
import type {
  CreateContactRequest,
  UpdateContactRequest,
} from './types';

// R6' — contact mutate + GET-by-id. The LIST + listContactsForCompany
// reads live in ../companies/companies-api.ts (R3 wired them there
// because R3 surfaces contacts as a company-detail panel). The mutate
// + single-DETAIL reads land here.
//
// Scopes (Gate-5 confirmed; libs/identity/prisma/seed.ts):
//   POST   /v1/contacts        → contact:create
//   GET    /v1/contacts/:id    → contact:read
//   PATCH  /v1/contacts/:id    → contact:edit
// The recruiter role-bundle holds all three.

export async function getContact(id: string): Promise<ContactView> {
  return apiClient.get<ContactView>(
    `/v1/contacts/${encodeURIComponent(id)}`,
  );
}

// Contact-spec amendment v1.0 — the server-side faceted page (GET /v1/contacts?
// paged=true). Same route + gate as the list (contact:read). Returns {items,
// next_cursor, facets, total}; the workspace builds `params` via
// buildContactQuery(). "My contacts" (scope=mine) is enforced SERVER-SIDE via an
// owner_id predicate derived from the JWT — never a client filter.
export async function searchContacts(
  params: URLSearchParams,
): Promise<ContactSearchPage> {
  return apiClient.get<ContactSearchPage>(`/v1/contacts?${params.toString()}`);
}

export async function createContact(
  body: CreateContactRequest,
): Promise<ContactView> {
  return apiClient.post<ContactView>('/v1/contacts', body);
}

export async function updateContact(
  id: string,
  body: UpdateContactRequest,
): Promise<ContactView> {
  return apiClient.patch<ContactView>(
    `/v1/contacts/${encodeURIComponent(id)}`,
    body,
  );
}
