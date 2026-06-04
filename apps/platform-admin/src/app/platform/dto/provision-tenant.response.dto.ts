export interface ProvisionTenantResponseDto {
  tenant_id: string;
  tenant_name: string;
  owner_user_id: string;
  owner_email: string;
  membership_id: string;
  capabilities: string[];
  invitation_sent: true;
}
