// DOC-3 E-Sign domain errors. Mapped to registered AramoError codes at the
// sign-service HTTP boundary:
//   EnvelopeNotFoundError            -> ENVELOPE_NOT_FOUND (404)
//   EnvelopeIllegalTransitionError   -> ENVELOPE_ILLEGAL_TRANSITION (409)
//   EnvelopeAlreadyExecutedError     -> ENVELOPE_ALREADY_EXECUTED (409)
//   SignerNotFoundError              -> SIGNER_NOT_FOUND (404)
//   SigningSessionInvalidError       -> SIGNING_SESSION_INVALID (401)
//   SigningSessionExpiredError       -> SIGNING_SESSION_EXPIRED (401)
//   DisclosureNotAcceptedError       -> DISCLOSURE_NOT_ACCEPTED (409)
//   SignatureFieldIncompleteError    -> SIGNATURE_FIELD_INCOMPLETE (409)
//   SignatureFieldValueRefusedError  -> VALIDATION_ERROR (400)
//   EsignIdempotencyConflictError    -> IDEMPOTENCY_KEY_CONFLICT (409)
// Kept lib-local so libs/sign stays HTTP/registry-agnostic (ATS-neutral).

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

// ES-1 — raised for ANY signer action (exchange, resolve, disclosure, fill,
// complete, decline) on an envelope in a terminal state (COMPLETED | DECLINED |
// VOIDED | EXPIRED). `status` names the terminal state for the caller.
export class EnvelopeAlreadyExecutedError extends Error {
  constructor(public readonly envelopeId: string, public readonly status?: string) {
    super(`SignatureEnvelope ${envelopeId} is already in a terminal state${status !== undefined ? ` (${status})` : ''}`);
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

// M-A6 §2.3 — `reason` (stable) names the completion rule that failed:
// required_field_unfilled | checkbox_required_unchecked |
// checkbox_group_select_one | checkbox_group_min_selected. `group_key` names the
// failing check-box group, when there is one.
export class SignatureFieldIncompleteError extends Error {
  constructor(
    public readonly signerId: string,
    public readonly reason = 'required_field_unfilled',
    public readonly group_key?: string,
  ) {
    super(`Signer ${signerId} has unfilled required signature fields`);
    this.name = 'SignatureFieldIncompleteError';
  }
}

// M-A6 §2 (coordinator ruling) — an engine-only field type (one a sender cannot
// author, e.g. ACKNOWLEDGEMENT) sent on the replace-all field PUT is kept only when
// it names an existing field of the envelope and is identical to the stored row.
// `index` is the position of the offending item in the request.
export class SenderFieldPassthroughRefusedError extends Error {
  constructor(public readonly index: number) {
    super(`field ${index + 1}: field type not available in this version`);
    this.name = 'SenderFieldPassthroughRefusedError';
  }
}

// M-A6 §2.2/§2.3 — a signer's fill value refused (VALIDATION_ERROR 400 at the
// HTTP boundary). Stable reasons: signer_profile_name_server_filled (a
// SIGNER_PROFILE name is filled by the server, never by a client) and
// checkbox_value_invalid (check boxes take 'true' or 'false' only).
export class SignatureFieldValueRefusedError extends Error {
  constructor(public readonly fieldId: string, public readonly reason: string) {
    super(reason === 'signer_profile_name_server_filled'
      ? 'This name is filled from the signer profile and cannot be entered'
      : reason === 'payment_field_server_filled'
        ? 'A payment field is completed by paying, not by entering a value'
        : 'A check box value must be true or false');
    this.name = 'SignatureFieldValueRefusedError';
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
// Mapped to ESIGN_REMINDER_NOT_ALLOWED (409) at the sign-service HTTP boundary.
export class ReminderNotAllowedError extends Error {
  constructor(public readonly reason: string) {
    super(`reminder not allowed: ${reason}`);
    this.name = 'ReminderNotAllowedError';
  }
}

// COMM-RECRUITER-W1 (W1-C1) — more than one NON-TERMINAL envelope exists for the
// same (tenant, document_ref, document_revision_ref). Fail-closed integrity
// ambiguity: the caller must never silently pick one. Mapped to
// ESIGN_ENVELOPE_AMBIGUOUS (409) at the sign-service HTTP boundary.
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

// Aramo Sign launch (A-7) — a disclosure acceptance named a version E-Sign does
// not hold, or a hash that does not match that version's server-held text.
// Mapped to VALIDATION_ERROR (400) at the sign-service HTTP boundary.
export class DisclosureVersionInvalidError extends Error {
  constructor(public readonly version: string) {
    super(`disclosure version ${version} is unknown or its text hash does not match`);
    this.name = 'DisclosureVersionInvalidError';
  }
}

// Multi-Signer Amendment §4 — in a SEQUENTIAL envelope only the lowest-ordered unsigned
// signer may act. Enforced by the signing engine (not just by withholding invitations).
export class SignerNotYetEligibleError extends Error {
  // Feature-Parity directive §1.17 — reason 'witness_signer_not_signed' when a WITNESS
  // acts before the signer it witnesses has signed (undefined: the sequential turn rule).
  constructor(public readonly signerId: string, public readonly reason?: 'witness_signer_not_signed') {
    super(
      reason === 'witness_signer_not_signed'
        ? `Signer ${signerId} is a witness: the signer they witness has not signed yet`
        : `Signer ${signerId} is not yet eligible to sign: an earlier signer has not signed`,
    );
    this.name = 'SignerNotYetEligibleError';
  }
}

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.9 — the recipient has an
// access code and this session has not entered it (reason access_code_required), or
// the code entered was wrong (access_code_incorrect, with the attempts left).
// Mapped to SIGNER_ACCESS_CODE_REQUIRED (403).
export class SignerAccessCodeRequiredError extends Error {
  constructor(
    public readonly signerId: string,
    public readonly reason: 'access_code_required' | 'access_code_incorrect' = 'access_code_required',
    public readonly attemptsRemaining?: number,
  ) {
    super(reason === 'access_code_incorrect' ? 'The access code is not correct' : 'Enter the access code the sender gave you');
    this.name = 'SignerAccessCodeRequiredError';
  }
}

// §1.9 — too many wrong access codes: the recipient is locked out of the envelope.
// Mapped to SIGNER_ACCESS_CODE_LOCKED (423).
export class SignerAccessCodeLockedError extends Error {
  constructor(public readonly signerId: string) {
    super('Too many incorrect access codes. Contact the sender.');
    this.name = 'SignerAccessCodeLockedError';
  }
}

// §1.17 — a delegation the engine refuses, with a stable reason. Mapped to
// ENVELOPE_ILLEGAL_TRANSITION (409) / VALIDATION_ERROR (400) at the HTTP boundary.
export type DelegationRefusal =
  | 'delegation_not_allowed'
  | 'not_delegable_recipient'
  | 'already_delegated'
  | 'signer_not_awaiting'
  | 'delegate_email_on_envelope'
  | 'delegate_invalid';

export class DelegationRefusedError extends Error {
  constructor(public readonly reason: DelegationRefusal) {
    super(`delegation refused: ${reason}`);
    this.name = 'DelegationRefusedError';
  }
}
