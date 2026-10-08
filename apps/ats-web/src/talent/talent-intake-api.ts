import { apiClient } from '@aramo/fe-foundation';

import type { TalentRecordView } from './types';

// Durable Async Résumé-First Talent Intake — FE client. The durable record is
// the authority: every call reads/writes the persisted TalentIntakeDraft, so the
// recruiter can leave and return (any session/device). SSE is NOTIFICATION-ONLY
// — on a 'draft' event the FE refetches the authoritative GET.

export interface TalentIntakeField {
  value: string | boolean | null;
  origin: 'RESUME_EXTRACTION' | 'RECRUITER';
}

export interface TalentIntakeReviewPayload {
  fields: Record<string, TalentIntakeField>;
  work_history?: unknown[];
  skills?: unknown[];
  education?: unknown[];
  certifications?: unknown[];
  resume_provenance?: { source_map_version?: string; resume_text_hash?: string };
}

export interface CreateTalentIntakeDraftResponse {
  draft_id: string;
  upload_url: string;
  storage_key: string;
  processing_status: string;
  expires_at: string;
}

export interface TalentIntakeAccepted {
  draft_id: string;
  processing_status: string;
}

// Possible existing Talent (email match) — backend authority (§15). V1:
// continue_anyway is always false (the active-email 409 is preserved), so the FE
// renders Open existing Talent + Discard, never "Continue anyway".
export interface TalentIntakeDuplicate {
  talent_record_id: string;
  display_name: string;
  title: string | null;
  location: string | null;
  reason: 'email';
  continue_anyway: boolean;
}

// Completeness guidance (§5.1 "n of 5 required") — NOT the create gate.
export interface TalentIntakeRequired {
  met: number;
  total: number;
}

export interface TalentIntakeDraftView {
  id: string;
  source_filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  processing_status: string;
  review_status: string;
  structured_payload: unknown;
  review_payload: TalentIntakeReviewPayload | null;
  warning: string | null;
  failure: string | null;
  promoted_talent_record_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  processing_completed_at: string | null;
  last_touched_at: string | null;
  duplicate: TalentIntakeDuplicate | null;
  required: TalentIntakeRequired;
  admissible: boolean;
  actions: string[];
}

export interface TalentIntakeDraftListItem {
  id: string;
  source_filename: string | null;
  processing_status: string;
  review_status: string;
  promoted_talent_record_id: string | null;
  created_at: string;
  updated_at: string;
  last_touched_at: string | null;
  required: TalentIntakeRequired;
  admissible: boolean;
  display_name: string | null;
}

export interface TalentIntakeDraftListResponse {
  items: TalentIntakeDraftListItem[];
}

const BASE = '/v1/talent-intake-drafts';

export async function createTalentIntakeDraft(body: {
  filename: string;
  content_type: string;
}): Promise<CreateTalentIntakeDraftResponse> {
  return apiClient.post<CreateTalentIntakeDraftResponse>(BASE, body);
}

export async function completeTalentIntakeUpload(
  id: string,
  body: { artifact_sha256?: string } = {},
): Promise<TalentIntakeAccepted> {
  return apiClient.post<TalentIntakeAccepted>(
    `${BASE}/${encodeURIComponent(id)}/complete-upload`,
    body,
  );
}

export async function listTalentIntakeDrafts(): Promise<TalentIntakeDraftListResponse> {
  return apiClient.get<TalentIntakeDraftListResponse>(BASE);
}

export async function getTalentIntakeDraft(id: string): Promise<TalentIntakeDraftView> {
  return apiClient.get<TalentIntakeDraftView>(`${BASE}/${encodeURIComponent(id)}`);
}

export async function patchTalentIntakeReview(
  id: string,
  body: { review: TalentIntakeReviewPayload; expected_version: number },
): Promise<TalentIntakeDraftView> {
  return apiClient.patch<TalentIntakeDraftView>(`${BASE}/${encodeURIComponent(id)}`, body);
}

export async function retryTalentIntakeExtraction(id: string): Promise<TalentIntakeDraftView> {
  return apiClient.post<TalentIntakeDraftView>(`${BASE}/${encodeURIComponent(id)}/retry`, {});
}

export async function promoteTalentIntakeDraft(id: string): Promise<TalentRecordView> {
  return apiClient.post<TalentRecordView>(`${BASE}/${encodeURIComponent(id)}/promote`, {});
}

// Replace the résumé on an existing draft → fresh presigned upload target; the
// browser uploads then calls completeTalentIntakeUpload (re-queues extraction).
export async function replaceTalentIntakeResume(
  id: string,
  body: { filename: string; content_type: string },
): Promise<CreateTalentIntakeDraftResponse> {
  return apiClient.post<CreateTalentIntakeDraftResponse>(
    `${BASE}/${encodeURIComponent(id)}/replace-resume`,
    body,
  );
}

// Discard an unfinished draft (and its résumé object). The only deletion path —
// no age-based auto-deletion.
export async function discardTalentIntakeDraft(id: string): Promise<void> {
  return apiClient.delete<void>(`${BASE}/${encodeURIComponent(id)}`);
}

// SSE NOTIFICATION — opens the event stream and calls onChange() on each 'draft'
// notification (the FE then refetches the authoritative GET). Returns a closer.
// A failed/absent stream is harmless: the caller keeps a polling fallback and GET
// is always authoritative. No payload is read from the event beyond the signal.
export function openTalentIntakeEvents(id: string, onChange: () => void): () => void {
  let es: EventSource | null = null;
  try {
    es = new EventSource(`${BASE}/${encodeURIComponent(id)}/events`, { withCredentials: true });
    es.addEventListener('draft', () => onChange());
    es.addEventListener('not_found', () => es?.close());
    es.onerror = () => {
      // Notification channel only — never fatal. The polling fallback + GET keep
      // the UI correct if the stream drops.
    };
  } catch {
    es = null;
  }
  return () => es?.close();
}
