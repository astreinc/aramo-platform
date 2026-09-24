import { apiClient } from '@aramo/fe-foundation';

// DOC-6 (R-6-8) — the recruiter-facing offer-letter client. Consumes the apps/api
// offer-document orchestrator (request/send) + the DERIVED status read-model. No
// offer-letter business truth lives here; the backend stays authoritative for status.
// The signer identity is resolved server-side from the Offer — never supplied here (PL-2).
//
// PL-5: there is NO Copy-link / Resend client here. The E-Sign seam
// (SIGNATURE_PROVIDER_PORT) exposes no safe server-issued signing-URL retrieval or
// resend operation, and raw signing tokens never leave esign-service; reconstructing a
// signing URL client-side is forbidden. Those actions are omitted in v1 rather than
// weakening the public-signing security model.

export interface OfferDocumentRequestBody {
  offer_id: string;
}
export interface OfferDocumentRequestResponse {
  document_id: string;
  offer_id: string;
}
export interface OfferDocumentSendResponse {
  document_id: string;
  envelope_id: string;
  status: string;
}
export interface OfferDocumentStatusResponse {
  document_id: string;
  status: string; // derived: PREPARING | AWAITING_SIGNATURE | EXECUTED
  document_status: string;
}

export async function requestOfferDocument(body: OfferDocumentRequestBody): Promise<OfferDocumentRequestResponse> {
  return apiClient.post<OfferDocumentRequestResponse>('/v1/offer-documents', body);
}

export async function sendOfferDocument(documentId: string, offer_id: string): Promise<OfferDocumentSendResponse> {
  return apiClient.post<OfferDocumentSendResponse>(`/v1/offer-documents/${documentId}/send`, { offer_id });
}

export async function getOfferDocumentStatus(documentId: string): Promise<OfferDocumentStatusResponse> {
  return apiClient.get<OfferDocumentStatusResponse>(`/v1/offer-documents/${documentId}/status`);
}
