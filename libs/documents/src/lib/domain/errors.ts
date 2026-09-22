// DOC-1a lib-local domain errors (mirrors communications' domain/errors.ts).
// The controller layer (boundary 6) maps these to registered AramoError codes:
//   DocumentNotFoundError          -> DOCUMENT_NOT_FOUND (404)
//   DocumentIllegalTransitionError -> DOCUMENT_ILLEGAL_TRANSITION (409)
// Keeping them lib-local preserves the scope:boundary neutrality (no HTTP/error
// registry dependency inside the domain).

export class DocumentNotFoundError extends Error {
  constructor(public readonly documentId: string) {
    super(`Document ${documentId} not found`);
    this.name = 'DocumentNotFoundError';
  }
}

export class DocumentIllegalTransitionError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Illegal document transition ${from} -> ${to}`);
    this.name = 'DocumentIllegalTransitionError';
  }
}

// Mapped by the controller (boundary 6) to IDEMPOTENCY_KEY_CONFLICT (409):
// same idempotency key replayed with a DIFFERENT request hash.
export class DocumentIdempotencyConflictError extends Error {
  constructor(public readonly key: string) {
    super(`Idempotency key ${key} was already used with a different request`);
    this.name = 'DocumentIdempotencyConflictError';
  }
}

// A DocumentStoragePort capability declared in the contract but not enforced in
// DOC-1a (S3 Object Lock / WORM / legal-hold / generic presigned write). The
// R27.1 storage-hardening increment implements these; until then the adapter
// fails loudly rather than silently no-op'ing an integrity control.
export class DocumentStorageNotSupportedError extends Error {
  constructor(public readonly capability: string) {
    super(`DocumentStoragePort capability not yet supported in DOC-1a: ${capability}`);
    this.name = 'DocumentStorageNotSupportedError';
  }
}
