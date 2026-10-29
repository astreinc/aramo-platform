// PX-V1 F1 (D-1) — E-Sign-OWNED source-document storage. Unlike CORE_REF (which
// pulls a frozen Core Documents revision over HTTP), OWNED source PDFs are bytes
// E-Sign holds in its OWN object storage — the standalone (non-ATS) path. The
// composition root (apps/sign-service) binds this to an ObjectStorageService
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
  // A1 — optional caller-chosen object id (UUID), so the storage ledger can key
  // the object before it is written; the adapter generates one otherwise.
  object_id?: string;
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
  // Sign Mobile D-W6-3 — remove OWNED source bytes of a draft document that was
  // deleted (never of a sent envelope). Idempotent. Optional so existing bindings
  // keep compiling; without it the bytes stay until storage lifecycle removes them.
  deleteOwnedSource?(source_object_key: string): Promise<void>;
  // SX-2 — the key putOwnedSource will use for this object id, so a caller can key the
  // storage ledger before the write and release it by the stored key later. Optional:
  // callers fall back to the legacy `esign/source/` layout when unbound.
  plannedSourceKey?(tenant_id: string, envelope_id: string, object_id: string): string;
}
