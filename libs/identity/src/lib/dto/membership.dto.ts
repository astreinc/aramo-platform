// MembershipDto — public shape of UserTenantMembership.
// Membership is the authorization boundary (directive §3 Cardinality).
// site_id (PR-A1a Ruling 4): NULL = tenant-wide membership (pre-A1a
// behavior preserved); set = site-scoped membership.
export interface MembershipDto {
  id: string;
  user_id: string;
  tenant_id: string;
  site_id: string | null;
  is_active: boolean;
  // Invite-S2 — the per-tenant 3-state invite machine
  // (INVITED | ACCEPTED | ACTIVE). See INVITE_STATUSES guard.
  invite_status: string;
  joined_at: string;
  deactivated_at: string | null;
  created_at: string;
  updated_at: string;
}
