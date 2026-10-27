// Aramo Sign Mobile (M-A2 §2.2, M-A3 §6/§7) — domain refusals for the envelope
// contracts. Lib-local and HTTP-agnostic like domain/errors.ts; sign-service maps
// each to an AramoError with a stable details.reason.

// M-A3 §6 — the caller's If-Match revision is not the envelope's current revision
// (checked under the envelope row lock). Mapped to 412 revision_mismatch.
export class EnvelopeRevisionMismatchError extends Error {
  constructor(
    public readonly envelopeId: string,
    public readonly currentRevision: number,
    public readonly expectedRevision: number,
  ) {
    super(`SignatureEnvelope ${envelopeId} is at revision ${currentRevision}, not ${expectedRevision}`);
    this.name = 'EnvelopeRevisionMismatchError';
  }
}

export type ReminderLimitReason = 'reminder_cooldown' | 'reminder_daily_limit';

// M-A3 §7 — a reminder refused by the per-signer cooldown or the per-envelope
// rolling 24-hour limit. Mapped to 429 with retry_after.
export class ReminderLimitError extends Error {
  constructor(
    public readonly reason: ReminderLimitReason,
    public readonly retryAt: Date,
  ) {
    super(`reminder refused (${reason}); retry at ${retryAt.toISOString()}`);
    this.name = 'ReminderLimitError';
  }
}

export type InboxSigningRefusal =
  | 'association_inactive'
  | 'envelope_not_signable'
  | 'signer_ineligible'
  | 'not_your_turn'
  | 'session_revoked'
  | 'link_expired';

// M-A2 §2.2 — POST /v1/sign/inbox/:id/sign revalidation failed. Mapped to 409.
export class InboxSigningRefusedError extends Error {
  constructor(public readonly reason: InboxSigningRefusal) {
    super(`inbox signing refused: ${reason}`);
    this.name = 'InboxSigningRefusedError';
  }
}

// M-A3 §7/§8 — the Idempotency-Key was already used in this scope with a
// different request body. Mapped to 422 idempotency_key_reuse.
export class IdempotencyKeyReuseError extends Error {
  constructor() {
    super('Idempotency-Key was already used with a different request');
    this.name = 'IdempotencyKeyReuseError';
  }
}

// M-A3 §7/§8 — a request with the same Idempotency-Key is still being processed.
// Mapped to 409 idempotency_request_in_progress (retry shortly).
export class IdempotencyRequestInProgressError extends Error {
  constructor() {
    super('A request with this Idempotency-Key is still in progress');
    this.name = 'IdempotencyRequestInProgressError';
  }
}

// Aramo-Sign-Unified-Product-Amendment-M-A5 §3 / §4 — a hosted or self-sign session
// could not be issued. Mapped by sign-service to an AramoError with this reason
// (404 signer_not_found, 403 not_bound_to_you / email_not_verified, 409 otherwise).
export type SessionIssueRefusal =
  | 'signer_not_found'
  | 'envelope_not_signable'
  | 'not_in_person_signer'
  | 'not_bound_to_you'
  | 'email_not_verified'
  | 'signer_ineligible'
  | 'not_your_turn';

export class SessionIssueRefusedError extends Error {
  constructor(public readonly reason: SessionIssueRefusal) {
    super(`signing session not issued: ${reason}`);
    this.name = 'SessionIssueRefusedError';
  }
}

// M-A5 §3.4 — a HOSTED session's disclosure acceptance must carry the name the
// signer confirmed. Mapped to 400 attested_name_required.
export class AttestedNameRequiredError extends Error {
  constructor() {
    super('attested_name is required to accept the disclosure in a hosted session');
    this.name = 'AttestedNameRequiredError';
  }
}
