import { apiClient } from '@aramo/fe-foundation';

// DOC-5 (R-5-12) — the recruiter-facing RTR client. Consumes the apps/api RTR
// orchestrator (request/send) + the DERIVED status read-model. No RTR business
// truth lives here; the backend remains authoritative for status + readiness.

export interface RtrRequestBody {
  talent_id: string;
  requisition_id: string;
  company_id: string;
}
export interface RtrRequestResponse {
  document_id: string;
}
export interface RtrSendResponse {
  document_id: string;
  envelope_id: string;
  status: string;
}
export interface RtrStatusResponse {
  document_id: string;
  status: string; // derived: REQUESTED | AWAITING_SIGNATURE | EXECUTED
  document_status: string;
}

// RTR-TEMPLATE-1 — recruiter-safe provenance from the PINNED template version
// (never today's active template). No internal ids.
export interface RtrTemplateProvenance {
  name: string;
  version_number: number;
}

export interface RtrCurrentResponse {
  document_id: string;
  status: string; // derived: REQUESTED | AWAITING_SIGNATURE | EXECUTED
  document_status: string;
  template: RtrTemplateProvenance | null;
  preview_available: boolean;
  executed_available: boolean;
  certificate_available: boolean;
}

export interface RtrPreviewResponse {
  url: string;
  expires_at: string;
  content_sha256: string;
}

export async function requestRtr(body: RtrRequestBody): Promise<RtrRequestResponse> {
  return apiClient.post<RtrRequestResponse>('/v1/rtr', body);
}

export async function sendRtr(documentId: string, talent_id: string): Promise<RtrSendResponse> {
  return apiClient.post<RtrSendResponse>(`/v1/rtr/${documentId}/send`, { talent_id });
}

// COMM-RECRUITER-W1 (W1-C3) — same-envelope reminder. RTR business state is
// unchanged (stays AWAITING_SIGNATURE); the backend reverse-resolves the envelope.
export interface RtrRemindResponse {
  document_id: string;
  status: string;
  reminder_sent: boolean;
}
export async function remindRtr(documentId: string): Promise<RtrRemindResponse> {
  return apiClient.post<RtrRemindResponse>(`/v1/rtr/${documentId}/remind`, {});
}

export async function getRtrStatus(documentId: string): Promise<RtrStatusResponse> {
  return apiClient.get<RtrStatusResponse>(`/v1/rtr/${documentId}/status`);
}

// Authoritative current-RTR lookup for an exact (talent, requisition) so the panel
// restores state on reload. Returns null when none exists (normal).
export async function getCurrentRtr(
  talentId: string,
  requisitionId: string,
): Promise<RtrCurrentResponse | null> {
  const res = await apiClient.get<{ current: RtrCurrentResponse | null }>(
    `/v1/rtr/current?talent_id=${encodeURIComponent(talentId)}&requisition_id=${encodeURIComponent(requisitionId)}`,
  );
  return res.current;
}

// Presigned read access to the exact frozen unsigned RTR artifact (no storage key).
export async function getRtrPreview(documentId: string): Promise<RtrPreviewResponse> {
  return apiClient.get<RtrPreviewResponse>(`/v1/rtr/${documentId}/preview`);
}
