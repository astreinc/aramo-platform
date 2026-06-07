import { apiClient } from '@aramo/fe-foundation';

import type {
  AttachmentListResponse,
  TalentRecordListResponse,
  TalentRecordView,
} from './types';

// The Talent LIST is the POOL-OPEN surface: GET /v1/talent-records is
// tenant + (optional) site scoped on the BE with NO assignment filter
// — a recruiter sees the whole tenant's talent pool within their site,
// not a personal list. R2 calls the endpoint raw; the framing happens
// in the view copy (the empty-state, the page header).

export async function listTalent(): Promise<TalentRecordListResponse> {
  return apiClient.get<TalentRecordListResponse>('/v1/talent-records');
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
