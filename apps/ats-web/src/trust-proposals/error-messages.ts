import { ApiError } from '@aramo/fe-foundation';

// Plain-language mapping for the Trust Proposals worklist LIST fetch (mirrors
// ../identity-advisories/error-messages.ts). Switches on ApiError.status; never
// surfaces a raw envelope code.
export function proposalListErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) {
      return 'You do not have permission to view trust proposals.';
    }
    if (err.status === 404) {
      return 'These proposals could not be found.';
    }
    if (err.status === 409 || err.status === 400) {
      return 'This proposal was already resolved, or the input was rejected.';
    }
  }
  return 'The trust proposals could not be loaded. Please try again.';
}

// The per-row ACT (verify/renew) refusal mapping. The consent gate — a 403 with
// the VERIFICATION_CONSENT_REQUIRED code — is a FACT about the row, not an error:
// the FE renders it as the row's "Consent required" state. Everything else is a
// generic retry message.
export function verifyActErrorState(err: unknown): 'consent_required' | 'error' {
  if (
    err instanceof ApiError &&
    err.status === 403 &&
    err.code === 'VERIFICATION_CONSENT_REQUIRED'
  ) {
    return 'consent_required';
  }
  return 'error';
}
