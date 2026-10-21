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
//
// ROLES-1 PR-2 (Directive v1.0 LOCKED §1/§3; ADR-0035 R1–R3) — the organization and
// product role model. Row ids are kept, keys are renamed by the
// 20261021130000_roles1_role_model migration:
//   - `ats_admin` (row …0010, formerly `tenant_admin`): ATS administration only —
//     today's ATS superset minus the six organization-wide administration scopes.
//   - `tenant_admin` (row …02b0, formerly `org_admin`): the ORGANIZATION
//     administrator — the org set + the admin scopes of every entitled product
//     (ATS, Sign) except billing and the owner-only acts.
//   - `tenant_owner` (row …0014, key unchanged): the ORGANIZATION owner —
//     tenant_admin + Sign billing + the owner-only acts.
//   - `org_admin` no longer exists. `sign_owner` (row …02a0) is deactivated by the
//     migration; its key is retired from code in ROLES-1 PR-3.
export const SEED_ROLE_KEYS = [
  // ROLES-1 PR-2 — ats_admin: the renamed pre-AUTHZ-1 `tenant_admin` row (…0010).
  'ats_admin',
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
  // ROLES-1 PR-2 (§1, §3.2) — tenant_admin: the ORGANIZATION administrator (the
  // renamed IC-3 PR-7 `org_admin` row …02b0). Holds ORG_ADMIN_SCOPE_KEYS + the full
  // ATS set of ats_admin + sign_admin's Sign scopes (no billing). Assignable in any
  // tenant (ORG_ROLE_KEYS); the session filters scope each product to its consumer.
  'tenant_admin',
  // AUTHZ-2 — 1 platform role (super_admin; platform:* scope namespace only).
  'super_admin',
  // PX-V1 PX-3 — E-Sign SENDER product roles (esign.aramo.ai). Namespace-separate
  // from the ATS tenant roles (like super_admin): they hold ONLY esign:* scopes and
  // are excluded from the tenant ATS RolePicker (role-catalog exclusion by `sign:`
  // prefix). Shared Aramo identity substrate; independent E-Sign product.
  'sign_owner',
  'sign_admin',
  'sign_sender',
  'sign_viewer',
] as const;
export type SeedRoleKey = (typeof SEED_ROLE_KEYS)[number];

// ROLES-1 PR-2 (§3.3) — the ORGANIZATION roles (ADR-0035 R1): owner and administrator
// of the whole tenant. Assignable in ANY tenant (no product capability gate): they are
// in neither product partition below. Product rights ride their static bundles and are
// exercised only through a consumer whose product the tenant holds (§3.1, IC-2 PR-6).
export const ORG_ROLE_KEYS = ['tenant_owner', 'tenant_admin'] as const;
export type OrgRoleKey = (typeof ORG_ROLE_KEYS)[number];

// IC-3 PR-7 — the organization-management scope set: EXACTLY the scopes the
// `@RequireCapability('core')` organization routes demand at the baseline
// (tenant profile, domain verification, sites, user management + roles
// catalog, directory read, audit trail, tenant settings) plus the baseline
// session marker every tenant role carries. Derived from the live route
// decorators, never widened: no `identity:resolve` (talent-identity
// dispositions), no `org:manage`/`team:manage` (ATS-gated D4a), no product
// scope. This set is BOTH the organization part of the tenant_admin / tenant_owner
// bundles (ROLES-1 PR-2; formerly the whole org_admin bundle) and the organization
// subset an `sign` consumer may carry (IC-0 §F.2 rule 4 / N-2).
export const ORG_ADMIN_SCOPE_KEYS = [
  'tenant:admin:profile',
  'tenant:admin:domain',
  'tenant:admin:sites',
  'tenant:admin:user-manage',
  'tenant:admin:settings',
  'tenant:user:read:directory',
  'audit:read',
  'auth:session:read',
] as const;

// IC-2 PR-5 (IC-0 §F.2 rule 2 / L10) — the PLATFORM-TIER partition of the
// catalog. These keys are grantable ONLY against the platform sentinel tenant
// (apps/platform-admin's own invite flow, which passes allow_platform_roles);
// every tenant-side assignment path (tenant invite, PATCH roles, platform-tier
// invite INTO a tenant) refuses them with VALIDATION_ERROR
// `platform_role_not_assignable`. TENANT_ASSIGNABLE_ROLE_KEYS is the DTO-level
// allow-list for tenant-facing surfaces (SEED minus the platform partition).
export const PLATFORM_ROLE_KEYS = ['super_admin'] as const;
export const TENANT_ASSIGNABLE_ROLE_KEYS: readonly SeedRoleKey[] = SEED_ROLE_KEYS.filter(
  (k) => !(PLATFORM_ROLE_KEYS as readonly string[]).includes(k),
);

// IC-3 PR-8 (IC-0 §F.2 rule 2 / L10; PX-V1 §10–§11) — the E-SIGN PRODUCT
// partition of the catalog: the Sign roles (PX-V1 PX-3). ROLES-1 PR-2 (§3.3): the
// target set is sign_admin / sign_sender / sign_viewer; `sign_owner` stays in the
// prefix-derived set until ROLES-1 PR-3 retires the key from code (its row is
// deactivated by the PR-2 migration, so it is unresolvable and never assignable). They hold ONLY
// esign:* scopes and are assignable ONLY in a tenant that holds the `sign`
// capability; every tenant-side assignment path (tenant invite, PATCH roles,
// platform-tier invite INTO a tenant) refuses them for an unentitled tenant
// with VALIDATION_ERROR `esign_role_not_entitled` (400 — the L10 shape, the
// same status the platform-role refusal uses). Derived from SEED_ROLE_KEYS by
// the `sign_` prefix so a new Sign role joins the partition without a hand
// list; the seed spec pins the membership.
export const ESIGN_PRODUCT_ROLE_KEYS: readonly SeedRoleKey[] = SEED_ROLE_KEYS.filter((k) =>
  k.startsWith('sign_'),
);

// IC-3 PR-8 — the SINGLE scope that authorizes the Sign SEND action
// (PX-V1 §11 rule 5: send authority derives from the `sign` capability + an
// org role, never bare authentication). Granted by the seed to sign_admin,
// sign_sender and — ROLES-1 PR-2 (Conforming Amendment 2) — the organization roles
// tenant_owner and tenant_admin; sign_viewer, ats_admin, every other ATS role and
// super_admin never hold it.
export const ESIGN_SENDER_SCOPE_KEY = 'sign:envelope:send' as const;

// D-ORG (§3.F) — the ATS PRODUCT partition of the catalog: every tenant role that
// carries ATS product scopes and administers or works in ATS only (the AUTHZ-1/1b
// staffing roles and, ROLES-1 PR-2 §3.3, ats_admin). Assignable ONLY in a tenant
// that holds the `ats` capability — the symmetric twin of ESIGN_PRODUCT_ROLE_KEYS
// (IC-3 PR-8): VALIDATION_ERROR `ats_role_not_entitled`.
// NOT in this partition: the organization roles (ORG_ROLE_KEYS — tenant_owner and
// tenant_admin, assignable in any tenant; Conforming Amendment 3), super_admin
// (platform), the Sign roles (esign partition) and the portal-user role (portal axis).
export const ATS_PRODUCT_ROLE_KEYS: readonly SeedRoleKey[] = SEED_ROLE_KEYS.filter(
  (k) =>
    !(ORG_ROLE_KEYS as readonly string[]).includes(k) &&
    k !== 'candidate' &&
    !(PLATFORM_ROLE_KEYS as readonly string[]).includes(k) &&
    !k.startsWith('sign_'),
);

// RoleDto — public shape of the Role entity.
export interface RoleDto {
  id: string;
  key: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
