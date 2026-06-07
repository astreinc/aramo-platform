import { apiClient } from '@aramo/fe-foundation';

import type {
  ActivityListResponse,
  CreateNoteRequest,
  ActivityView,
} from './types';

export async function listActivities(
  subjectType: 'requisition' | 'pipeline',
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
