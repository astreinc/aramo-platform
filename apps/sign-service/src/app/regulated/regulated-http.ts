import { AramoError } from '@aramo/common';
import {
  EstampProviderNotConfiguredError,
  QesProviderError,
  QesProviderNotConfiguredError,
  RegulatedSigningStateError,
  RegulatedSigningValidationError,
} from '@aramo/sign';

// Feature-Parity §1.16 / §1.19 (Amendment A1) — HTTP mapping of the QES and e-stamp
// workflow errors onto EXISTING error codes (no new codes). Returns null for any other
// error so the caller falls through to its usual mapping.
export function regulatedHttp(e: unknown, requestId: string): AramoError | null {
  if (e instanceof QesProviderNotConfiguredError || e instanceof EstampProviderNotConfiguredError) {
    return new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', 'This feature is not available in Aramo Sign yet', 403, {
      requestId,
      details: { feature_key: e instanceof QesProviderNotConfiguredError ? 'sign.qes' : 'sign.india_estamp', reason: 'provider_not_configured' },
    });
  }
  if (e instanceof RegulatedSigningValidationError) {
    return new AramoError('VALIDATION_ERROR', e.message, 400, { requestId, details: { field: e.field, reason: e.reason } });
  }
  if (e instanceof RegulatedSigningStateError) {
    return new AramoError('ENVELOPE_ILLEGAL_TRANSITION', e.message, 409, { requestId, details: { reason: e.reason } });
  }
  if (e instanceof QesProviderError) {
    // The signer may start again; the QTSP's own message is never echoed.
    return new AramoError('ENVELOPE_ILLEGAL_TRANSITION', 'The qualified trust service provider did not complete this step', 409, {
      requestId,
      details: { reason: 'qes_provider_refused', provider_reason: e.reason },
    });
  }
  return null;
}
