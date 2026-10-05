// DOC-3 E-Sign domain errors. Mapped to registered AramoError codes at the
// esign-service HTTP boundary:
//   EnvelopeNotFoundError            -> ENVELOPE_NOT_FOUND (404)
//   EnvelopeIllegalTransitionError   -> ENVELOPE_ILLEGAL_TRANSITION (409)
//   EnvelopeAlreadyExecutedError     -> ENVELOPE_ALREADY_EXECUTED (409)
//   SignerNotFoundError              -> SIGNER_NOT_FOUND (404)
//   SigningSessionInvalidError       -> SIGNING_SESSION_INVALID (401)
//   SigningSessionExpiredError       -> SIGNING_SESSION_EXPIRED (401)
//   DisclosureNotAcceptedError       -> DISCLOSURE_NOT_ACCEPTED (409)
//   SignatureFieldIncompleteError    -> SIGNATURE_FIELD_INCOMPLETE (409)
//   EsignIdempotencyConflictError    -> IDEMPOTENCY_KEY_CONFLICT (409)
// Kept lib-local so libs/esign stays HTTP/registry-agnostic (ATS-neutral).

export class EnvelopeNotFoundError extends Error {
  constructor(public readonly envelopeId: string) {
    super(`SignatureEnvelope ${envelopeId} not found`);
    this.name = 'EnvelopeNotFoundError';
  }
}

export class EnvelopeIllegalTransitionError extends Error {
  constructor(public readonly from: string, public readonly to: string) {
    super(`Illegal envelope transition ${from} -> ${to}`);
    this.name = 'EnvelopeIllegalTransitionError';
  }
}

export class EnvelopeAlreadyExecutedError extends Error {
  constructor(public readonly envelopeId: string) {
    super(`SignatureEnvelope ${envelopeId} is already in a terminal state`);
    this.name = 'EnvelopeAlreadyExecutedError';
  }
}

export class SignerNotFoundError extends Error {
  constructor(public readonly signerId: string) {
    super(`Signer ${signerId} not found`);
    this.name = 'SignerNotFoundError';
  }
}

export class SigningSessionInvalidError extends Error {
  constructor(public readonly reason: string) {
    super(`Signing session invalid: ${reason}`);
    this.name = 'SigningSessionInvalidError';
  }
}

export class SigningSessionExpiredError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Signing session ${sessionId} expired or revoked`);
    this.name = 'SigningSessionExpiredError';
  }
}

export class DisclosureNotAcceptedError extends Error {
  constructor(public readonly signerId: string) {
    super(`Signer ${signerId} has not accepted the e-sign disclosure`);
    this.name = 'DisclosureNotAcceptedError';
  }
}

export class SignatureFieldIncompleteError extends Error {
  constructor(public readonly signerId: string) {
    super(`Signer ${signerId} has unfilled required signature fields`);
    this.name = 'SignatureFieldIncompleteError';
  }
}

export class EsignIdempotencyConflictError extends Error {
  constructor(public readonly key: string) {
    super(`Idempotency key ${key} was already used with a different request`);
    this.name = 'EsignIdempotencyConflictError';
  }
}

// COMM-RECRUITER-W1 (W1-C2) — a reminder was requested for an envelope that is
// not in a remindable (SENT|IN_PROGRESS) lifecycle, or has no incomplete signer.
// Mapped to ESIGN_REMINDER_NOT_ALLOWED (409) at the esign-service HTTP boundary.
export class ReminderNotAllowedError extends Error {
  constructor(public readonly reason: string) {
    super(`reminder not allowed: ${reason}`);
    this.name = 'ReminderNotAllowedError';
  }
}

// COMM-RECRUITER-W1 (W1-C1) — more than one NON-TERMINAL envelope exists for the
// same (tenant, document_ref, document_revision_ref). Fail-closed integrity
// ambiguity: the caller must never silently pick one. Mapped to
// ESIGN_ENVELOPE_AMBIGUOUS (409) at the esign-service HTTP boundary.
export class EnvelopeAmbiguousError extends Error {
  constructor(
    public readonly documentRef: string,
    public readonly documentRevisionRef: string,
    public readonly count: number,
  ) {
    super(
      `ambiguous active envelope linkage for document ${documentRef} revision ${documentRevisionRef} (${count} non-terminal envelopes)`,
    );
    this.name = 'EnvelopeAmbiguousError';
  }
}
