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
// AUTHZ-1 (2026-06-04) expanded the tenant role catalog from 4 to 13.
// AUTHZ-1b (2026-06-04) revises the catalog to the staffing-vertical set
// (13 -> 12): retires 5 non-staffing roles (viewer, hiring_manager,
// interviewer, coordinator, external_agency — no A2-A8 regression: every
// guard is scope-keyed, ZERO role-name-keyed on the retired roles), adds
// 4 staffing roles (recruiting_manager, delivery_manager, lead_recruiter,
// back_office), renames finance_hr -> finance (KEY rename; bundle
// preserved; grep-confirmed zero JWT/guard refs). candidate is preserved.
// No new scope keys are added (management roles' broader visibility comes
// from the TEAM MODEL at D4a/b, NOT a see-all scope here).
//
// AUTHZ-2 (2026-06-04) adds the PLATFORM-TIER role `super_admin` — a
// 13th catalog entry but in a separate NAMESPACE: its bundle holds only
// `platform:*` scopes (never tenant scopes), and the 12 tenant roles
// hold only tenant scopes (never `platform:*`). The DDR §13.1 tripwire
// is enforced by namespace partition + the consumer_type check at the
// guard layer — a platform token never satisfies a tenant guard, and
// vice versa.
//
// Settings S4 (2026-06-05) adds the tenant-tier `auditor_with_financials`
// role — the Auditor/Compliance bundle's 5 read scopes + the see-all
// compensation:view:* set. Tenant catalog grows 12 → 13 (total 14
// including super_admin). Grantable only when the tenant's
// `audit.financials_enabled` KNOWN_SETTING is true (the GATE precondition
// fires at the role-assign path; the seed grant of the role is not gated
// — the GATE is keyed at the membership-write boundary).
export const SEED_ROLE_KEYS = [
  // Pre-AUTHZ-1 tenant roles preserved across AUTHZ-1b (keys identical).
  'tenant_admin',
  'recruiter',
  'candidate',
  // AUTHZ-1 / AUTHZ-1b — 9 staffing-tenant roles.
  'tenant_owner',
  'account_manager',
  'sourcer',
  'finance', // AUTHZ-1b KEY rename: finance_hr -> finance (bundle preserved)
  'auditor',
  'recruiting_manager', // AUTHZ-1b (people-management; Recruiter + user-manage)
  'delivery_manager',   // AUTHZ-1b (fulfillment quality gate; read + submittal:approve)
  'lead_recruiter',     // AUTHZ-1b (= Recruiter operationally; lead-ness via D4b)
  'back_office',        // AUTHZ-1b (operational-read + activity; capability scopes deferred)
  // Settings S4 — auditor_with_financials (compliance + see-all-comp,
  // gated by audit.financials_enabled).
  'auditor_with_financials',
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
