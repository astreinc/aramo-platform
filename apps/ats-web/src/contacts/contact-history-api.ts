import { ApiError, apiClient } from '@aramo/fe-foundation';

import { listActivities } from '../activity/activity-api';
import type { ActivityListResponse, ActivityView } from '../activity/types';

// CONTACTS-1 §8 (H-1..H-4) — a contact's activity history rides the existing
// manual activity route with subject_type='contact':
//   GET  /v1/activities?subject_type=contact&subject_id=… → activity:read,
//        scoped to the actor's contact visibility (an invisible contact lists
//        nothing)
//   POST /v1/activities {type, subject_type:'contact', subject_id, notes}
//        → activity:create; 404 for an invisible contact, 422 CONTACT_DELETED
//        for a deleted one. A recorded row moves the contact's
//        last_activity_at forward server-side.

export const CONTACT_HISTORY_KINDS = ['note', 'call', 'email_logged'] as const;
export type ContactHistoryKind = (typeof CONTACT_HISTORY_KINDS)[number];

export const CONTACT_HISTORY_KIND_LABELS: Readonly<Record<ContactHistoryKind, string>> = {
  note: 'Note',
  call: 'Call',
  email_logged: 'Email',
};

export async function listContactHistory(contactId: string): Promise<ActivityListResponse> {
  return listActivities('contact', contactId);
}

export async function recordContactActivity(
  contactId: string,
  body: { readonly type: ContactHistoryKind; readonly notes: string },
): Promise<ActivityView> {
  return apiClient.post<ActivityView>('/v1/activities', {
    type: body.type,
    subject_type: 'contact',
    subject_id: contactId,
    notes: body.notes,
  });
}

export function contactHistoryLoadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return 'You do not have permission to view this contact’s history.';
  }
  return 'The contact history could not be loaded.';
}

export function contactHistoryRecordErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'CONTACT_DELETED') {
      return 'This contact has been deleted. Restore it to record activity.';
    }
    if (error.status === 403) {
      return 'You do not have permission to record activity on this contact.';
    }
    if (error.status === 404) {
      return 'This contact is no longer visible. Nothing was saved.';
    }
    if (error.code === 'VALIDATION_ERROR' || error.status === 400) {
      return 'The entry could not be saved — please check the text and try again.';
    }
  }
  return 'The entry failed to save. Please try again.';
}
