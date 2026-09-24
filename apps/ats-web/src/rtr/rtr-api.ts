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

export async function requestRtr(body: RtrRequestBody): Promise<RtrRequestResponse> {
  return apiClient.post<RtrRequestResponse>('/v1/rtr', body);
}

export async function sendRtr(documentId: string, talent_id: string): Promise<RtrSendResponse> {
  return apiClient.post<RtrSendResponse>(`/v1/rtr/${documentId}/send`, { talent_id });
}

export async function getRtrStatus(documentId: string): Promise<RtrStatusResponse> {
  return apiClient.get<RtrStatusResponse>(`/v1/rtr/${documentId}/status`);
}
