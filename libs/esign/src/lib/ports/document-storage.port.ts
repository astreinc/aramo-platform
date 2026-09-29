// PX-V1 F1 (D-1) — E-Sign-OWNED source-document storage. Unlike CORE_REF (which
// pulls a frozen Core Documents revision over HTTP), OWNED source PDFs are bytes
// E-Sign holds in its OWN object storage — the standalone (non-ATS) path. The
// composition root (apps/esign-service) binds this to an ObjectStorageService
// adapter; tests bind an in-memory stub. Independent-Digital-Signature-Platform
// Directive §16 — E-Sign owns its own signing-domain persistence.

export const DOCUMENT_STORAGE_PORT = 'DOCUMENT_STORAGE_PORT';

export interface PutOwnedSourceInput {
  tenant_id: string;
  envelope_id: string;
  // Caller-neutral logical key segment; the adapter composes the final key.
  filename: string;
  content_type: string;
  bytes: Uint8Array;
}

export interface PutOwnedSourceResult {
  source_object_key: string;
  byte_size: number;
  source_sha256: string;
}

export interface DocumentStoragePort {
  // Store frozen OWNED source bytes and return the durable object key + integrity.
  putOwnedSource(input: PutOwnedSourceInput): Promise<PutOwnedSourceResult>;
  // Read frozen OWNED source bytes by their durable object key.
  getOwnedSource(source_object_key: string): Promise<Uint8Array>;
}
