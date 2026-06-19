import { apiClient } from '@aramo/fe-foundation';

import type {
  ActivityListResponse,
  CreateNoteRequest,
  ActivityView,
} from './types';

// R3 widening — the read endpoint accepts the same enum the BE filter
// accepts; for R3 the talent DETAIL reads subject_type='talent_record'
// and the company DETAIL reads subject_type='company'. The send-side
// CreateNoteRequest stays narrower (R1's typed FE union) — only the
// read signature widens.
export async function listActivities(
  subjectType: 'requisition' | 'pipeline' | 'talent_record' | 'company' | 'contact',
  subjectId: string,
): Promise<ActivityListResponse> {
  const params = new URLSearchParams({
    subject_type: subjectType,
    subject_id: subjectId,
  });
  return apiClient.get<ActivityListResponse>(
    `/v1/activities?${params.toString()}`,
  );
}

export async function createNote(body: CreateNoteRequest): Promise<ActivityView> {
  return apiClient.post<ActivityView>('/v1/activities', body);
}
