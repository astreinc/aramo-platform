// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED (2bd74ca5…) §1.9 — recipient
// verification by government ID — and Amendment A1 (dc95b283…): the vendor-neutral port.
// The default vendor (D-3) is Stripe Identity (stripe-identity.adapter.ts); with no vendor
// configured the DISABLED adapter answers every call with IdentityVerificationUnavailableError.
//
// R-5 (BIPA / DPDP): raw ID images and document data stay at the vendor. An adapter returns
// only the outcome, the vendor's session reference, the issuing country and — TRANSIENTLY,
// for the name comparison — the verified first and last name. The service compares the name
// in memory and persists only whether it matched. Nothing else of the document is read.

export const IDENTITY_VERIFICATION_PORT = 'IDENTITY_VERIFICATION_PORT';

/** The provider keys stored on SignRecipientIdentityVerification.provider. */
export type IdentityVerificationProviderKey = 'STRIPE_IDENTITY' | 'DISABLED';

/** Where a vendor verification session stands. PENDING = the recipient has not finished. */
export type IdentityVerificationOutcome = 'PENDING' | 'VERIFIED' | 'FAILED' | 'CANCELLED';

export interface StartIdentityVerificationInput {
  /** SignRecipientIdentityVerification.id — sent to the vendor as opaque metadata. */
  attempt_id: string;
  tenant_id: string;
  envelope_id: string;
  signer_id: string;
  /** Where the vendor's hosted page sends the recipient when they finish (no token in it). */
  return_url: string;
}

export interface StartedIdentityVerification {
  vendor_reference: string;
  /** The vendor's hosted verification page (single-use). Returned to the recipient, never stored. */
  verification_url: string;
}

export interface IdentityVerificationResult {
  vendor_reference: string;
  outcome: IdentityVerificationOutcome;
  /** TRANSIENT (R-5): compared with the recipient's name in memory, never persisted. */
  verified_name: { first: string; last: string } | null;
  /** ISO 3166-1 alpha-2 issuing country of the document, when the vendor reports one. */
  document_country: string | null;
  /** The vendor's failure code (e.g. document_expired), when the outcome is FAILED. */
  failure_code: string | null;
}

/** A verified vendor callback. RESULT_AVAILABLE = re-read the session's result. */
export interface IdentityVerificationWebhookEvent {
  event_ref: string;
  kind: 'RESULT_AVAILABLE' | 'IGNORED';
  vendor_reference: string | null;
}

export interface IdentityVerificationPort {
  readonly provider: IdentityVerificationProviderKey;
  /** True only when the provider's key and webhook secret are both set. */
  isConfigured(): boolean;
  startSession(input: StartIdentityVerificationInput): Promise<StartedIdentityVerification>;
  /** The hosted URL of a session the recipient has not finished, or null when it cannot be resumed. */
  resumeUrl(vendor_reference: string): Promise<string | null>;
  /** The authoritative result of a session (a webhook body is never trusted beyond its id). */
  retrieveResult(vendor_reference: string): Promise<IdentityVerificationResult>;
  /** Ends a session at the vendor (after a failure, so it cannot later turn into a pass). */
  cancelSession(vendor_reference: string): Promise<void>;
  /** Asks the vendor to delete the session's collected data (Sign purge, R-5). */
  redactSession(vendor_reference: string): Promise<void>;
  /** Verifies the vendor's signature over the raw body before anything is parsed. */
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined, nowSec: number): IdentityVerificationWebhookEvent;
}

/** The provider is not configured, refused the request, or could not be reached. */
export class IdentityVerificationUnavailableError extends Error {
  constructor(
    readonly reason: string,
    readonly retryable = false,
  ) {
    super(`identity verification unavailable: ${reason}`);
    this.name = 'IdentityVerificationUnavailableError';
  }
}

export type IdentityVerificationWebhookRejection = 'NO_SECRET' | 'MISSING' | 'MALFORMED' | 'STALE' | 'BAD_SIGNATURE';

export class IdentityVerificationWebhookSignatureError extends Error {
  constructor(readonly reason: IdentityVerificationWebhookRejection) {
    super(`identity verification webhook rejected: ${reason}`);
    this.name = 'IdentityVerificationWebhookSignatureError';
  }
}

/** No vendor configured (the default): every call is refused, nothing leaves Aramo. */
export class DisabledIdentityVerificationAdapter implements IdentityVerificationPort {
  readonly provider = 'DISABLED' as const;

  isConfigured(): boolean {
    return false;
  }

  startSession(): Promise<StartedIdentityVerification> {
    return Promise.reject(new IdentityVerificationUnavailableError('provider_not_configured'));
  }

  resumeUrl(): Promise<string | null> {
    return Promise.reject(new IdentityVerificationUnavailableError('provider_not_configured'));
  }

  retrieveResult(): Promise<IdentityVerificationResult> {
    return Promise.reject(new IdentityVerificationUnavailableError('provider_not_configured'));
  }

  cancelSession(): Promise<void> {
    return Promise.reject(new IdentityVerificationUnavailableError('provider_not_configured'));
  }

  redactSession(): Promise<void> {
    return Promise.reject(new IdentityVerificationUnavailableError('provider_not_configured'));
  }

  verifyWebhook(): IdentityVerificationWebhookEvent {
    throw new IdentityVerificationWebhookSignatureError('NO_SECRET');
  }
}
