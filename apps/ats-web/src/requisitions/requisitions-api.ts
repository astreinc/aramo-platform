import { apiClient } from '@aramo/fe-foundation';

import type { AttachmentListResponse } from '../talent/types';

import type {
  CreateRequisitionRequest,
  RequisitionListResponse,
  RequisitionView,
  UpdateRequisitionRequest,
} from './types';
import type {
  ConfirmProfileRequest,
  DraftProfileRequest,
  DraftProfileResponse,
  IntakeDraftRequest,
  IntakeDraftResponse,
  RequisitionProfileView,
} from './golden-profile';

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
  params?: { company_id?: string; bookmarked?: boolean; q?: string },
): Promise<RequisitionListResponse> {
  const search = new URLSearchParams();
  // ATS-QA-1 D4 — the server title quick-search (?q=, requisition:search). It ANDs
  // with the A3/D4b visibility predicate on the BE: narrows, never widens.
  const q = params?.q?.trim();
  if (q !== undefined && q !== '') {
    search.set('q', q);
  }
  const companyId = params?.company_id;
  if (companyId !== undefined && companyId !== '') {
    search.set('company_id', companyId);
  }
  // PR-14 — "My Bookmarks": the server narrows to the caller's own
  // bookmarked requisitions (personal; never another user's).
  if (params?.bookmarked === true) {
    search.set('bookmarked', 'true');
  }
  const qs = search.toString();
  return apiClient.get<RequisitionListResponse>(
    qs === '' ? '/v1/requisitions' : `/v1/requisitions?${qs}`,
  );
}

// ATS-QA-1 I-1 (D4) — the PICKER read: server keyset paging over every requisition the
// caller can see (no fixed cap), filtered by status and searched by title or REQ number.
export interface RequisitionPickerPage {
  readonly items: readonly RequisitionView[];
  readonly next_cursor: string | null;
}

export async function listRequisitionsForPicker(params: {
  q?: string;
  statuses: readonly string[];
  cursor?: string | null;
  pageSize?: number;
}): Promise<RequisitionPickerPage> {
  const search = new URLSearchParams({ paged: 'true', status: params.statuses.join(',') });
  const q = params.q?.trim();
  if (q !== undefined && q !== '') search.set('q', q);
  if (params.cursor !== undefined && params.cursor !== null) search.set('cursor', params.cursor);
  if (params.pageSize !== undefined) search.set('page_size', String(params.pageSize));
  const r = await apiClient.get<{ items: RequisitionView[]; next_cursor?: string | null }>(`/v1/requisitions?${search.toString()}`);
  return { items: r.items, next_cursor: r.next_cursor ?? null };
}

export async function getRequisition(id: string): Promise<RequisitionView> {
  return apiClient.get<RequisitionView>(`/v1/requisitions/${id}`);
}

// PR-14 (Track C) — personal bookmark toggle. Idempotent SET: pass the
// DESIRED state. PERSONAL and invisible to other users; this NEVER toggles
// is_hot (the team-wide HOT pill). Returns the updated RequisitionView with
// its `bookmarked` flag reflecting the new state.
export async function setRequisitionBookmark(
  id: string,
  bookmarked: boolean,
): Promise<RequisitionView> {
  return apiClient.put<RequisitionView>(
    `/v1/requisitions/${encodeURIComponent(id)}/bookmark`,
    { bookmarked },
  );
}

// Requisition attachments (the detail Attachments tab). GET /v1/attachments
// filtered by owner_type='requisition' — the same endpoint the talent
// Attachments tab uses (owner_type='talent'). Read-only list; graceful on
// 403/empty.
export async function listRequisitionAttachments(
  requisitionId: string,
): Promise<AttachmentListResponse> {
  const params = new URLSearchParams({
    owner_type: 'requisition',
    owner_id: requisitionId,
  });
  return apiClient.get<AttachmentListResponse>(
    `/v1/attachments?${params.toString()}`,
  );
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

// New Requisition AI intake (charter §7.3) — the PRE-CREATION generation
// lane. POST /v1/requisitions/intake takes the intake text (a pasted client
// email OR a few hiring-manager lines) and returns the extracted fields + a
// drafted JD + must/nice requirement skills, for the recruiter to review,
// edit and commit via createRequisition. Mutates nothing server-side. An AI
// provider outage surfaces as an ApiError (AI_PROVIDER_UNAVAILABLE) — the
// caller renders an honest failure state; the draft is never fabricated.
export async function draftRequisitionFromIntake(
  body: IntakeDraftRequest,
): Promise<IntakeDraftResponse> {
  return apiClient.post<IntakeDraftResponse>('/v1/requisitions/intake', body);
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

// PR-A2 P3 — the first-class profile READ (GET /v1/requisitions/:id/profile,
// requisition:read-gated). Returns the un-nested GoldenProfile content + the
// has_profile flag. A profile-less requisition returns the empty-shaped view
// (has_profile false) — never a 404 — so the workbench renders cleanly for a
// req that has no profile yet.
export async function getRequisitionProfile(
  requisitionId: string,
): Promise<RequisitionProfileView> {
  return apiClient.get<RequisitionProfileView>(
    `/v1/requisitions/${encodeURIComponent(requisitionId)}/profile`,
  );
}

// Job-Module — the AI "Generate profile from brief" flow (draft → confirm).
//
// draftRequisitionProfile asks the BE to draft a golden profile + JD text
// from the recruiter's free-text brief. The response is NOT persisted as
// the live profile — it is a draft the recruiter reviews/edits, then
// confirms. The AI is assistive: confirm accepts a hand-edited profile,
// and a fully-manual profile is equally valid (generated_by: 'manual').
export async function draftRequisitionProfile(
  requisitionId: string,
  body: DraftProfileRequest,
): Promise<DraftProfileResponse> {
  return apiClient.post<DraftProfileResponse>(
    `/v1/requisitions/${encodeURIComponent(requisitionId)}/profile/draft`,
    body,
  );
}

// confirmRequisitionProfile persists the (possibly hand-edited) profile +
// JD text against the requisition. Returns the updated RequisitionView,
// now carrying golden_profile_id (the "Profile linked" indicator).
export async function confirmRequisitionProfile(
  requisitionId: string,
  body: ConfirmProfileRequest,
): Promise<RequisitionView> {
  return apiClient.post<RequisitionView>(
    `/v1/requisitions/${encodeURIComponent(requisitionId)}/profile/confirm`,
    body,
  );
}
