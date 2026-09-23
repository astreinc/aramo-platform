// DOC-4 (R-4-3) — E-Sign fetches the frozen source PDF bytes for executed-document
// production through this abstraction. The composition root (apps/esign-service)
// binds it to an authorized Documents read (esign → apps/api pull). E-Sign holds
// no DocumentStoragePort binding and never touches the documents schema.

export const DOCUMENT_SOURCE_PROVIDER_PORT = 'DOCUMENT_SOURCE_PROVIDER_PORT';

export interface DocumentSourceRequest {
  tenant_id: string;
  document_ref: string;
  document_revision_ref: string;
}

export interface DocumentSourceProviderPort {
  // Returns the immutable source PDF bytes for a frozen Documents revision.
  getSourcePdf(input: DocumentSourceRequest): Promise<Uint8Array>;
}
