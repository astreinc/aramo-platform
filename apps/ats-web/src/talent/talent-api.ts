import { ApiError, apiClient } from '@aramo/fe-foundation';

import type {
  AttachmentListResponse,
  AttachmentView,
  CreateAttachmentRequest,
  CreateTalentRecordRequest,
  DraftFromResumeRequest,
  EmailSlot,
  EmailVerificationRequestResult,
  EmailVerificationStatusResponse,
  ParseResumeResult,
  PresignedPutResult,
  ResumeUploadUrlRequest,
  TalentRecordListResponse,
  TalentRecordView,
  TalentSearchPage,
  UpdateTalentRecordRequest,
} from './types';

// The Talent LIST is the POOL-OPEN surface: GET /v1/talent-records is
// tenant + (optional) site scoped on the BE with NO assignment filter
// — a recruiter sees the whole tenant's talent pool within their site,
// not a personal list. R2 calls the endpoint raw; the framing happens
// in the view copy (the empty-state, the page header).

export async function listTalent(): Promise<TalentRecordListResponse> {
  return apiClient.get<TalentRecordListResponse>('/v1/talent-records');
}

// Segment 4d — the SERVER-SIDE faceted + keyset-paginated path (?paged=true).
// Filters, sort, presets (?preset=), the My-team scope (?scope=my_team) and the
// keyset cursor are all resolved on the BE (4a native / 4b cross-facet counts /
// 4c preset+scope resolution). The caller builds the param string via
// buildTalentQuery (talent-workspace). Returns the { items, next_cursor, facets,
// cross_facets } superset; the pre-Seg-4 `items`-only readers still work.
export async function searchTalent(
  params: URLSearchParams,
): Promise<TalentSearchPage> {
  return apiClient.get<TalentSearchPage>(
    `/v1/talent-records?${params.toString()}`,
  );
}

// R3 — the talent DETAIL endpoint (the Identity tab + the dependency
// for the other tabs' header). Returns the full TalentRecordView.
export async function getTalent(id: string): Promise<TalentRecordView> {
  return apiClient.get<TalentRecordView>(
    `/v1/talent-records/${encodeURIComponent(id)}`,
  );
}

// R3 — the talent Attachments tab. Ruling 1: owner_type='talent' (the
// BE A4-wired enum; the directive's 'talent_record' was a guess —
// substrate truth wins).
export async function listTalentAttachments(
  talentId: string,
): Promise<AttachmentListResponse> {
  const params = new URLSearchParams({
    owner_type: 'talent',
    owner_id: talentId,
  });
  return apiClient.get<AttachmentListResponse>(
    `/v1/attachments?${params.toString()}`,
  );
}

// R5 — talent CREATE / EDIT (the intake mutate-side).
//
// Both endpoints scope-gated server-side: POST requires talent:create;
// PATCH requires talent:edit. The recruiter role-bundle holds both
// (libs/identity/prisma/seed.ts:441-469 — Gate-5 confirmed).

export async function createTalent(
  body: CreateTalentRecordRequest,
): Promise<TalentRecordView> {
  return apiClient.post<TalentRecordView>('/v1/talent-records', body);
}

export async function updateTalent(
  id: string,
  body: UpdateTalentRecordRequest,
): Promise<TalentRecordView> {
  return apiClient.patch<TalentRecordView>(
    `/v1/talent-records/${encodeURIComponent(id)}`,
    body,
  );
}

// R5 — the résumé flow (the 3-step: upload-url → presigned PUT → parse).
//
// Step 1: ask the BE for a presigned PUT URL. Scope: attachment:create
// (NOT talent:create — Gate-5 surfaced this; the recruiter holds both
// so it's transparent in practice).
export async function requestResumeUploadUrl(
  body: ResumeUploadUrlRequest,
): Promise<PresignedPutResult> {
  return apiClient.post<PresignedPutResult>(
    '/v1/talent-records/resume-upload-url',
    body,
  );
}

// Step 2: PUT the file bytes DIRECTLY to S3 via the presigned URL. This
// is a RAW fetch — NOT through apiClient (no /api prefix, no session
// cookie, no JSON content-type override). The Content-Type header MUST
// match the `content_type` sent to requestResumeUploadUrl (the value is
// in the signature; a mismatch is rejected by S3 with 403).
//
// The orphan-pending lifecycle tag is BAKED INTO THE SIGNED URL
// server-side at presign time — the FE does NOT need to send any
// x-amz-tagging header. S3 lifecycle Rule 5 reaps unlinked objects
// after ~24h if the attachment-create is never called.
export async function putResumeToStorage(
  presignedUrl: string,
  file: File,
  contentType: string,
): Promise<void> {
  const response = await fetch(presignedUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': contentType },
  });
  if (!response.ok) {
    throw new ApiError(
      response.status,
      `Résumé upload failed: ${response.status}`,
    );
  }
}

// Step 3: ask the BE to parse the uploaded file. Scope: talent:read
// (Gate-5 surfaced — a parse is a READ-side draft, not a write). Returns
// {prefill, parse_status}. The endpoint NEVER throws on parse failure
// — a 'failed' status is a normal 200 response with empty prefill.
export async function parseDraftFromResume(
  body: DraftFromResumeRequest,
): Promise<ParseResumeResult> {
  return apiClient.post<ParseResumeResult>(
    '/v1/talent-records/draft-from-resume',
    body,
  );
}

// TR-3 B2 — request an email-verification for a STORED slot (email1|email2).
// Server derives the address from the stored field; the FE never sends a
// free-form address. Scope: talent:edit (server-gated).
export async function requestEmailVerification(
  recordId: string,
  slot: EmailSlot,
): Promise<EmailVerificationRequestResult> {
  return apiClient.post<EmailVerificationRequestResult>(
    `/v1/talent-records/${encodeURIComponent(recordId)}/email-verifications`,
    { slot },
  );
}

// TR-3 B2 — the per-slot email-verification status (two items, email1 then
// email2). Status is a band/label, never a numeric value.
export async function getEmailVerificationStatus(
  recordId: string,
): Promise<EmailVerificationStatusResponse> {
  return apiClient.get<EmailVerificationStatusResponse>(
    `/v1/talent-records/${encodeURIComponent(recordId)}/email-verifications`,
  );
}

// Step 4 (post-create): attach the uploaded file to the new talent.
// is_resume=true triggers the BE to auto-clear the orphan-pending tag
// (markResumeCommitted in attachment.controller.ts:146-158). The FE
// does NOT clear the tag manually.
export async function createAttachment(
  body: CreateAttachmentRequest,
): Promise<AttachmentView> {
  return apiClient.post<AttachmentView>('/v1/attachments', body);
}
