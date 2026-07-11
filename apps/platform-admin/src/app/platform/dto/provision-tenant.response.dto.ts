export interface ProvisionTenantResponseDto {
  tenant_id: string;
  tenant_name: string;
  owner_user_id: string;
  owner_email: string;
  membership_id: string;
  capabilities: string[];
  // Inc-3 PR-3.4 — true when the owner invitation email was sent at provision
  // (invite_owner omitted/true); false on the create-now-invite-later path.
  invitation_sent: boolean;
}
