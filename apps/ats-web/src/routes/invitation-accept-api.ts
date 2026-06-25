// Invite-S3 (§5) — the public invitation-acceptance client.
//
// The accept page has NO session (the invitee has not signed in — acceptance
// precedes first login). The single authority is the high-entropy token in the
// body; apiClient.post works with an empty cookie. The S2 contract:
//   200 { status: 'ACCEPTED', tenant_id }
//   400 { error: { code: 'VALIDATION_ERROR', details: { reason } } }
//        reason ∈ missing_token | invalid_token | expired | already_accepted | revoked

import { apiClient } from '@aramo/fe-foundation';

export const ACCEPT_PATH = '/v1/invitations/accept';

export interface AcceptResult {
  status: 'ACCEPTED';
  tenant_id: string;
}

export async function acceptInvitation(token: string): Promise<AcceptResult> {
  return apiClient.post<AcceptResult>(ACCEPT_PATH, { token });
}
