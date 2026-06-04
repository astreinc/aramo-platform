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
// the audit-focused auditor).
//
// AUTHZ-2 (2026-06-04) adds the PLATFORM-TIER role `super_admin` — the
// 14th catalog entry but in a separate NAMESPACE: its bundle holds only
// `platform:*` scopes (never tenant scopes), and the 13 tenant roles
// hold only tenant scopes (never `platform:*`). The DDR §13.1 tripwire
// is enforced by namespace partition + the consumer_type check at the
// guard layer — a platform token never satisfies a tenant guard, and
// vice versa. The TENANT 13-role catalog (rows above) is UNCHANGED
// (assertion in §5 proof step 8: A2–A8 + the AUTHZ-1 13-role bundle
// test stays green byte-for-byte).
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
  // AUTHZ-2 — 1 platform role (super_admin; platform:* scope namespace only).
  'super_admin',
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
