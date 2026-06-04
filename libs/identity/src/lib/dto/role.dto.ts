// Seed role catalog (directive §6, closed set for this PR).
// Adding a role key requires a directive amendment.
//
// PR-A1a Ruling 3 (2026-06-01) adds `candidate` — the portal-user role
// for talent subjects authenticating via the portal. Vocabulary note:
// `candidate` here is a ROLE name (the JWT principal-kind for a portal
// user), NOT entity vocabulary for the talent record. The talent record
// remains "talent"; only the portal-side role identifier is `candidate`.
// The Tier-2 vocabulary gate (scripts/verify-vocabulary.sh) currently
// substring-matches "candidate"; carry through to the report — Lead
// rules on (a) gate exclusion for this file vs (b) role rename to e.g.
// `portal_subject`.
//
// AUTHZ-1 (2026-06-04) expands the tenant role catalog from 4 to 13.
// The 4 pre-A1a keys are PRESERVED unchanged (DDR D7 additive-migration
// discipline — A2–A8 permission checks reference these keys verbatim
// and must stay green). The re-map to DDR display names is carried on
// the Role.description column (see prisma/seed.ts), NOT on the keys.
// 9 new tenant roles are added: tenant_owner, hiring_manager,
// account_manager, interviewer, sourcer, coordinator, finance_hr,
// auditor, external_agency. Per AUTHZ-1 §4 Lead ruling, viewer is
// kept as the 13th catalog entry (a generic read role distinct from
// the audit-focused auditor). The platform-tier super_admin role is
// OUT OF SCOPE for AUTHZ-1 and lives in AUTHZ-2 (apps/platform-admin).
export const SEED_ROLE_KEYS = [
  // 4 pre-AUTHZ-1 tenant roles (keys preserved; descriptions re-mapped).
  'tenant_admin',
  'recruiter',
  'viewer',
  'candidate',
  // AUTHZ-1 — 9 new tenant roles.
  'tenant_owner',
  'hiring_manager',
  'account_manager',
  'interviewer',
  'sourcer',
  'coordinator',
  'finance_hr',
  'auditor',
  'external_agency',
] as const;
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
