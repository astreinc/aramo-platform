export interface ProvisionTenantResponseDto {
  tenant_id: string;
  tenant_name: string;
  // IC-4 PR-9 — BUSINESS | PERSONAL (echoes the persisted Tenant.kind).
  tenant_kind: string;
  owner_user_id: string;
  owner_email: string;
  membership_id: string;
  capabilities: string[];
  // Inc-3 PR-3.4 — true when the owner invitation email was sent at provision
  // (invite_owner omitted/true); false on the create-now-invite-later path.
  invitation_sent: boolean;
}
