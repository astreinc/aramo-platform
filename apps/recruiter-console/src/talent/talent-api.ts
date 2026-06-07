import { apiClient } from '@aramo/fe-foundation';

import type { TalentRecordListResponse } from './types';

// The Talent LIST is the POOL-OPEN surface: GET /v1/talent-records is
// tenant + (optional) site scoped on the BE with NO assignment filter
// — a recruiter sees the whole tenant's talent pool within their site,
// not a personal list. R2 calls the endpoint raw; the framing happens
// in the view copy (the empty-state, the page header).

export async function listTalent(): Promise<TalentRecordListResponse> {
  return apiClient.get<TalentRecordListResponse>('/v1/talent-records');
}
