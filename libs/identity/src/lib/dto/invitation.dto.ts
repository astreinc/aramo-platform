// InvitationDto — Invite-S2 (Pattern-2) public shape of the Invitation row.
//
// The raw token is NEVER part of this DTO — it exists only transiently at
// issue time (returned once to the email path). This DTO carries the row's
// identity + lifecycle timestamps so the acceptance/lifecycle service can
// validate (expiry / single-use / revoke) and audit.
export interface InvitationDto {
  id: string;
  user_id: string;
  tenant_id: string;
  membership_id: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}
