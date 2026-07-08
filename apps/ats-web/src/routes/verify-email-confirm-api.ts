// TR-3 B2 — the PUBLIC email-verification confirm client.
//
// The confirm page has NO session (the talent has no account — they follow a
// tokenised link from their inbox). The single authority is the high-entropy
// token in the body; apiClient.post works with an empty cookie. The frozen
// contract:
//   200 { status: 'VERIFIED' }
//   404 { error: { code: 'NOT_FOUND', message, request_id, details: {} } }
//
// ORACLE-RESISTANT: EVERY failure — bad / expired / consumed / rotated /
// missing token, or rate-limited — returns ONE identical 404 NOT_FOUND
// envelope. There are NO distinct reason codes (unlike invitation-accept, which
// discriminates by details.reason); the indistinguishability is the whole
// point. The FE therefore renders ONE generic failure state — never branch on
// a reason here.

import { apiClient } from '@aramo/fe-foundation';

export const CONFIRM_PATH = '/v1/email-verifications/confirm';

export interface ConfirmResult {
  status: 'VERIFIED';
}

export async function confirmEmailVerification(
  token: string,
): Promise<ConfirmResult> {
  return apiClient.post<ConfirmResult>(CONFIRM_PATH, { token });
}
