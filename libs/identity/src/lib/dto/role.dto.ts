// Seed role catalog (directive §6, closed set for this PR).
// Adding a role key requires a directive amendment.
export const SEED_ROLE_KEYS = ['tenant_admin', 'recruiter', 'viewer'] as const;
export type SeedRoleKey = (typeof SEED_ROLE_KEYS)[number];

// RoleDto — public shape of the Role entity.
export interface RoleDto {
  id: string;
  key: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
