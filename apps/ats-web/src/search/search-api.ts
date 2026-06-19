import { apiClient } from '@aramo/fe-foundation';

import type { CompanyListResponse, ContactListResponse } from '../companies/types';
import type { RequisitionListResponse } from '../requisitions/types';
import type { TalentRecordListResponse } from '../talent/types';

// Search FE /search — the cross-entity quick-search fan-out client. Each
// function consumes the Search PR-1 (PR#221) per-entity ?q= primitive: the
// BE applies the ILIKE-contains trigram match ANDed with that entity's
// visibility predicate, and gates on the entity's search scope. The FE only
// calls the endpoints whose search scope the actor holds (the per-section
// scope-gate in SearchView) — so a call here is never expected to 403.
//
// Visibility is server-side (the ?q= results ARE the visibility-scoped
// truth) — NO client-side filtering, NO truncation banner (the R2-Companies
// / recruiter-home posture). Types are REUSED from the entity modules
// (hand-mirror; the same shapes the LIST views consume).

function withQuery(path: string, q: string): string {
  const params = new URLSearchParams({ q });
  return `${path}?${params.toString()}`;
}

export async function searchTalent(q: string): Promise<TalentRecordListResponse> {
  return apiClient.get<TalentRecordListResponse>(
    withQuery('/v1/talent-records', q),
  );
}

// Search PR-2 — the résumé CONTENT-search call (distinct ?resume_q= param).
// The BE matches the persisted+redacted résumé body (websearch_to_tsquery,
// ts_rank-ordered), ANDed with the talent visibility, gated on talent:search
// (the SAME scope as the name ?q= — D3 reuse). Each returned item carries a
// `resume_snippet` (ts_headline excerpt over the redacted text). Fired as a
// SEPARATE call from searchTalent — the FE merges name OR résumé matches
// (NOT ?q=&?resume_q= together, which the BE ANDs → near-empty).
export async function searchTalentByResume(
  q: string,
): Promise<TalentRecordListResponse> {
  const params = new URLSearchParams({ resume_q: q });
  return apiClient.get<TalentRecordListResponse>(
    `/v1/talent-records?${params.toString()}`,
  );
}

export async function searchCompanies(q: string): Promise<CompanyListResponse> {
  return apiClient.get<CompanyListResponse>(withQuery('/v1/companies', q));
}

export async function searchRequisitions(
  q: string,
): Promise<RequisitionListResponse> {
  return apiClient.get<RequisitionListResponse>(
    withQuery('/v1/requisitions', q),
  );
}

export async function searchContacts(q: string): Promise<ContactListResponse> {
  return apiClient.get<ContactListResponse>(withQuery('/v1/contacts', q));
}
