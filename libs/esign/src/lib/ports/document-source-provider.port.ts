// DOC-4 (R-4-3) / PX-V1 F1 — E-Sign fetches the frozen source PDF bytes for
// executed-document production through this abstraction. The composition root
// (apps/esign-service) binds it to a mode-dispatching resolver:
//   CORE_REF — an authorized Documents read (esign → apps/api pull), the legacy
//              ATS path (document_ref / document_revision_ref).
//   OWNED    — bytes E-Sign owns in its own object storage (source_object_key),
//              the standalone (non-ATS) path. Independent-Digital-Signature-
//              Platform Directive §16 (E-Sign owns its signing-domain persistence).

export const DOCUMENT_SOURCE_PROVIDER_PORT = 'DOCUMENT_SOURCE_PROVIDER_PORT';

export type EnvelopeDocumentSourceMode = 'OWNED' | 'CORE_REF';

export interface DocumentSourceRequest {
  tenant_id: string;
  source_mode: EnvelopeDocumentSourceMode;
  // Set for CORE_REF only.
  document_ref?: string | null;
  document_revision_ref?: string | null;
  // Set for OWNED only.
  source_object_key?: string | null;
}

export interface DocumentSourceProviderPort {
  // Returns the immutable source PDF bytes for the envelope document, resolving
  // by source_mode (CORE_REF → Documents pull, OWNED → E-Sign object storage).
  getSourcePdf(input: DocumentSourceRequest): Promise<Uint8Array>;
}
