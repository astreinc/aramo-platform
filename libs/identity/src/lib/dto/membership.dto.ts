// MembershipDto — public shape of UserTenantMembership.
// Membership is the authorization boundary (directive §3 Cardinality).
export interface MembershipDto {
  id: string;
  user_id: string;
  tenant_id: string;
  is_active: boolean;
  joined_at: string;
  deactivated_at: string | null;
  created_at: string;
  updated_at: string;
}
