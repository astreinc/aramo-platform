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

// DOC-2 — template + requirement domain errors. The controller maps these to:
//   TemplateNotFoundError                 -> TEMPLATE_NOT_FOUND (404)
//   TemplateVersionNotFoundError          -> TEMPLATE_VERSION_NOT_FOUND (404)
//   TemplateVersionNotActiveError         -> TEMPLATE_VERSION_NOT_ACTIVE (409)
//   TemplateImmutableError                -> TEMPLATE_IMMUTABLE (409)
//   DocumentRequirementNotFoundError      -> DOCUMENT_REQUIREMENT_NOT_FOUND (404)
//   DocumentRequirementAlreadySatisfiedError -> DOCUMENT_REQUIREMENT_ALREADY_SATISFIED (409)
export class TemplateNotFoundError extends Error {
  constructor(public readonly templateId: string) {
    super(`DocumentTemplate ${templateId} not found`);
    this.name = 'TemplateNotFoundError';
  }
}

export class TemplateVersionNotFoundError extends Error {
  constructor(public readonly versionId: string) {
    super(`TemplateVersion ${versionId} not found`);
    this.name = 'TemplateVersionNotFoundError';
  }
}

export class TemplateVersionNotActiveError extends Error {
  constructor(public readonly versionId: string, public readonly status: string) {
    super(`TemplateVersion ${versionId} is ${status}, not ACTIVE`);
    this.name = 'TemplateVersionNotActiveError';
  }
}

export class TemplateImmutableError extends Error {
  constructor(public readonly versionId: string) {
    super(`TemplateVersion ${versionId} is ACTIVE and immutable (DOC-2 R-2-3): edits require a new version`);
    this.name = 'TemplateImmutableError';
  }
}

export class DocumentRequirementNotFoundError extends Error {
  constructor(public readonly requirementId: string) {
    super(`DocumentRequirement ${requirementId} not found`);
    this.name = 'DocumentRequirementNotFoundError';
  }
}

export class DocumentRequirementAlreadySatisfiedError extends Error {
  constructor(public readonly requirementId: string, public readonly status: string) {
    super(`DocumentRequirement ${requirementId} is already ${status}`);
    this.name = 'DocumentRequirementAlreadySatisfiedError';
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
