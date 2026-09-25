// DOC-3 §229 — the PROVIDER-NEUTRAL cross-service contract Documents invokes to
// drive signature execution. apps/api (Documents composition) depends ONLY on
// this port; the concrete transport is an HTTP adapter to apps/esign-service.
// Future DocuSign/AdobeSign/Tenant providers implement the SAME caller-facing
// contract without changing RTR/Offer orchestration (R29 deferred). This is a
// TRANSPORT contract — no RTR/Submittal/Offer/Placement/recruiter-workflow shape.

export const SIGNATURE_PROVIDER_PORT = 'SIGNATURE_PROVIDER_PORT';

export interface ProviderDocumentInput {
  document_ref: string; // documents.Document id (opaque)
  document_revision_ref: string; // frozen documents.DocumentRevision id
  title: string;
  source_sha256: string;
  ordinal: number;
}

export interface ProviderSignerInput {
  email: string;
  name: string;
  signing_order: number;
  signer_role?: string;
}

export interface CreateEnvelopeRequest {
  tenant_id: string;
  subject: string;
  execution_mode: string; // ACKNOWLEDGEMENT|SINGLE_SIGNATURE|MULTI_SIGNATURE
  created_by: string;
  documents: ProviderDocumentInput[];
  signers: ProviderSignerInput[];
  idempotency_key?: string;
}

export interface ProviderSignerSummary {
  signer_id: string;
  email: string;
  status: string;
}

export interface EnvelopeSummary {
  envelope_id: string;
  status: string;
  signers: ProviderSignerSummary[];
}

export interface EvidenceSummary {
  envelope_id: string;
  status: string;
  event_chain_hash: string | null;
  signature: string | null;
  signature_algorithm: string | null;
  completed_at: string | null;
}

// The caller-facing signature-provider contract. Idempotent per Invariant 16.
export interface SignatureProviderPort {
  createEnvelope(req: CreateEnvelopeRequest): Promise<EnvelopeSummary>;
  sendEnvelope(tenant_id: string, envelope_id: string, idempotency_key?: string): Promise<EnvelopeSummary>;
  getEnvelope(tenant_id: string, envelope_id: string): Promise<EnvelopeSummary>;
  voidEnvelope(tenant_id: string, envelope_id: string, reason: string): Promise<EnvelopeSummary>;
  getEvidence(tenant_id: string, envelope_id: string): Promise<EvidenceSummary>;
}
