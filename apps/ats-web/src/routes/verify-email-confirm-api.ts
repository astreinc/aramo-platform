// TR-3 B2 → ATI-SEP-1 T10 WP3b (Addendum A3 T10-3) — the PUBLIC email
// verification confirm client: a 6-digit one-time code Talent Intelligence
// mailed to the talent.
//
// The confirm page has NO session (the talent has no account — they follow the
// emailed link, which carries ?verification_id=…, and type the code from the
// same email). apiClient.post works with an empty cookie. The contract:
//   200 { status: 'VERIFIED' }
//   400 VALIDATION_ERROR                 not a UUID id / not a 6-digit code
//   404 NOT_FOUND                        unknown verification / rate-limited (uniform)
//   422 IDENTIFIER_VERIFICATION_REFUSED  details.reason INVALID_CODE (+ attempts_remaining) |
//                                        VERIFICATION_EXPIRED | VERIFICATION_LOCKED | ALREADY_CONFIRMED
//   503 INTELLIGENCE_UNAVAILABLE

import { apiClient } from '@aramo/fe-foundation';

export const CONFIRM_PATH = '/v1/email-verifications/confirm';
export const VERIFICATION_CODE_LENGTH = 6;

export interface ConfirmResult {
  status: 'VERIFIED';
}

export async function confirmEmailVerification(verificationId: string, code: string): Promise<ConfirmResult> {
  return apiClient.post<ConfirmResult>(CONFIRM_PATH, { verification_id: verificationId, code });
}
