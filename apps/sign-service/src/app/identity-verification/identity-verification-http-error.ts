import { AramoError } from '@aramo/common';
import {
  IdentityVerificationUnavailableError,
  KbaUnavailableError,
  SignerIdentityVerificationLockedError,
  SignerIdentityVerificationRequiredError,
} from '@aramo/sign';

// Feature-Parity §1.9 — the HTTP refusals of recipient identity verification, shared by the
// signer routes (esign-http.controller toHttp) and the identity-verification routes.

/** The HTTP refusal for an identity-verification error, or null when `e` is not one. */
export function identityVerificationHttpError(e: unknown, requestId: string): AramoError | null {
  if (e instanceof SignerIdentityVerificationRequiredError) {
    return new AramoError('SIGNER_IDENTITY_VERIFICATION_REQUIRED', e.message, 403, { requestId, details: { reason: 'identity_verification_required', method: e.method } });
  }
  if (e instanceof SignerIdentityVerificationLockedError) {
    return new AramoError('SIGNER_IDENTITY_VERIFICATION_LOCKED', e.message, 423, { requestId, details: { reason: e.reason } });
  }
  if (e instanceof IdentityVerificationUnavailableError || e instanceof KbaUnavailableError) {
    return new AramoError('ESIGN_IDENTITY_VERIFICATION_UNAVAILABLE', 'Identity verification is not available right now', 503, { requestId, details: { reason: e.reason } });
  }
  return null;
}

