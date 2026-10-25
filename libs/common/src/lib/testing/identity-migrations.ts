import { resolve } from 'node:path';

// Shared identity migration-registration helper (Platform-Console Inc-2 PR-1.5,
// Workstream C). Elevated from backlog by PR-1's red cycle: 23 integration-spec
// sites hand-encoded the libs/identity migration set in three forms, and a
// form-unaware bulk edit broke the list. This module is the single ordered
// source of truth for the identity migration set so the NEXT identity migration
// is a ONE-LINE edit HERE, not a 23-site sweep.
//
// ── Invariant 1: ARRAY ORDER, not timestamp order. ────────────────────────────
// The list is applied in ARRAY order by every consumer's apply loop, NOT sorted
// by the timestamp prefix. `init` is always first; the additive tenant-column
// migrations (allowed_domain / domain_verification / slug) are applied before
// the older-timestamp site/authz/profile migrations. This is a DEPENDENCY/topic
// ordering that happens to diverge from timestamp order — it works because the
// migrations are largely independent additive CREATEs. When you add a migration
// that DEPENDS on an earlier one, append/insert it AFTER its dependency here;
// do not assume timestamp order is applied.
//
// ── Invariant 2: backfills must not read later-migration columns. ─────────────
// A migration's backfill (an UPDATE inside its own .sql) must only read columns
// introduced by migrations that precede it in THIS array. PR-1's tenant-status
// backfill had to be rewritten order-independent for exactly this reason. Keep
// backfills self-contained to columns at or before their own position.
//
// ── Scope (PR-1.5 ruling: bounded + documented). ──────────────────────────────
// The 23 curated sites do NOT share one identity set — recon found ≥6 distinct
// (subset, order) signatures; each spec applies only the migrations its scenario
// needs. This helper carries the FULL ordered set (16 as of IC-1 PR-3); sites that apply a
// pure-identity subset are retrofitted to consume it (the extra additive tables
// are behavior-neutral). Sites that interleave the identity set with other
// schema stacks (entitlement / talent-trust / talent-record / …) stay
// hand-listed for now WITH a comment — their divergence is formal, not
// behavioral, and full convergence is deferred to avoid churning CI-verified
// apps/api specs in this PR. See the PR description for the retrofit cohort.

// The full libs/identity migration set, in APPLY order (Invariant 1). Paths are
// repo-root-relative; each consumer resolves them against the repo root it
// computes from its own __dirname. Adding the next identity migration = append
// ONE line here.
export const IDENTITY_MIGRATIONS: readonly string[] = [
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
  'libs/identity/prisma/migrations/20260625000000_add_tenant_allowed_domain/migration.sql',
  'libs/identity/prisma/migrations/20260626000000_add_tenant_domain_verification/migration.sql',
  'libs/identity/prisma/migrations/20260626120000_add_tenant_slug/migration.sql',
  'libs/identity/prisma/migrations/20260624000000_add_invitation_and_invite_status/migration.sql',
  'libs/identity/prisma/migrations/20260601000000_add_site_axis/migration.sql',
  'libs/identity/prisma/migrations/20260604000000_add_authz_team_models/migration.sql',
  'libs/identity/prisma/migrations/20260619000000_add_tenant_profile/migration.sql',
  'libs/identity/prisma/migrations/20260620000000_add_site_hierarchy/migration.sql',
  'libs/identity/prisma/migrations/20260627000000_add_tenant_identity_provider/migration.sql',
  'libs/identity/prisma/migrations/20260709130000_add_tenant_lifecycle_status/migration.sql',
  // HF-AUTH-1 — the AuthorizationVersion table (monotonic per-principal authz
  // revision). Additive CREATE with no cross-dependency, so it applies last. The
  // identity.repository bump paths write to it on membership create/disable/role
  // change, so EVERY identity/auth-service integration spec needs it present.
  'libs/identity/prisma/migrations/20260901000000_hf_auth_1_authorization_version/migration.sql',
  // IC-1 PR-2 — owning tenant on User (Amendment A1, one User / one tenant).
  // `expand` adds the NULLABLE column + FK + index + UNIQUE(id, tenant_id) (additive,
  // old-image safe); `backfill` assigns each User its single membership tenant and
  // ABORTS the file when any User would remain unowned. Both apply LAST: the
  // regenerated Prisma client SELECTs `tenant_id` on every User read, so every
  // consumer that reads User through the client needs `expand` applied. The backfill
  // reads only UserTenantMembership (init) — Invariant 2 holds.
  'libs/identity/prisma/migrations/20261015000000_ic1_user_tenant_owner_expand/migration.sql',
  'libs/identity/prisma/migrations/20261015000001_ic1_user_tenant_owner_backfill/migration.sql',
  // IC-4 PR-9 — Tenant.kind (BUSINESS | PERSONAL), additive with default. The
  // regenerated client SELECTs `kind` on every Tenant read, so every consumer
  // that reads Tenant through the client needs this applied (Invariant 2 holds:
  // ALTER TABLE on identity.Tenant only). Ordered BEFORE the IC-1 restrict files
  // (re-timestamped from 20261017000000): the single release image reads `kind`,
  // so it must land in Release A (`--until` this file) with expand + backfill,
  // before the image is recreated and before cardinality/immutable apply.
  'libs/identity/prisma/migrations/20261015000002_ic4_tenant_kind/migration.sql',
  // IC-1 PR-3 — RESTRICT. `cardinality` re-runs the backfill, pre-validates (no unowned
  // User, no multi-membership User, no membership/owner tenant mismatch — each a
  // single-statement raise), then SET NOT NULL + UNIQUE(user_id) on membership + the
  // composite membership→owner FK. `immutable` adds the single-quoted plpgsql trigger
  // (no `$$`). From here every fixture that inserts a User MUST supply tenant_id and
  // may hold at most ONE membership, in that tenant.
  'libs/identity/prisma/migrations/20261016000000_ic1_user_tenant_cardinality/migration.sql',
  'libs/identity/prisma/migrations/20261016000001_ic1_user_tenant_immutable/migration.sql',
  // Aramo Sign launch — self-service BUSINESS signup requests (additive table).
  'libs/identity/prisma/migrations/20261019120000_sign_self_service_signup/migration.sql',
  // AUTH-SIGNIN-1 / Sign federated owner signup — the narrow provider-pin cohort
  // and per-link provider (two additive tables; no existing read changes).
  'libs/identity/prisma/migrations/20261020200000_sign_signup_idp_pin/migration.sql',
  // ROLES-1 PR-1 (§4.1) — last-owner invariant: plpgsql AFTER ROW triggers on
  // UserTenantMembershipRole / UserTenantMembership / User (no column, no shape
  // change). Applied LAST: it reads Tenant.status (lifecycle) and the init tables only.
  'libs/identity/prisma/migrations/20261021120100_roles1_last_owner_invariant/migration.sql',
  // ROLES-1 PR-2 (§5.2) — the role model reconciliation: one guarded DO block (a no-op on a
  // database without a role catalog, which is every fresh test database — the seed writes
  // the ROLES-1 model) + the empty identity._roles1_owner_resolution table (S-2). No
  // returned-shape change. Applied LAST: it reads every earlier identity table.
  'libs/identity/prisma/migrations/20261021130000_roles1_role_model/migration.sql',
  // DOC-TEMPLATE-LIB-1 T-4 (§6.3) — document_template grants move to the organization roles
  // (+ document_template:read for sign_admin / sign_sender). One guarded DO block on fixed
  // role ids (a no-op on a database without a role catalog). No returned-shape change.
  // AFTER the ROLES-1 role model (it requires row 0010 = ats_admin, 02b0 = tenant_admin).
  'libs/identity/prisma/migrations/20261021150000_doclib_t4_document_template_grants/migration.sql',
  // DOC-TEMPLATE-LIB-1 T-5 (§6.4) — sign:template:use / :manage removed (2 Scope rows on
  // fixed ids 0x140d/0x140e + their grants on the Sign role rows). One guarded DO block (a
  // no-op when the rows are absent). No returned-shape change.
  'libs/identity/prisma/migrations/20261021160100_doclib_t5_remove_sign_template_scopes/migration.sql',
  // Sign Signup Amendment A1 (LOCKED) — OrganizationAuthorityAttestation + TenantBillingRegionPolicy.
  // Two new tables (FK to Tenant). No returned-shape change.
  'libs/identity/prisma/migrations/20261022100000_sign_signup_org_details/migration.sql',
  // Domain-Enforcement P3 (LOCKED) — TenantDomainClaim + holder index (grandfather
  // backfill), TenantDomainException, DomainVerificationDelegation. New tables only; no
  // existing table or response shape changes.
  'libs/identity/prisma/migrations/20261022110000_domain_enforcement_p3/migration.sql',
  // Sign Personal (Free) Launch v1.1 (LOCKED) §7 — PersonalSignupRequest, TenantRiskState,
  // PersonalSignupInvite. New tables only (FKs to Tenant / User); no existing table or
  // response shape changes.
  'libs/identity/prisma/migrations/20261022120000_sign_personal_free/migration.sql',
  // ORG-UX-1 (LOCKED §4.1/§4.2) — document_template:author (Scope row ensured on the seed id
  // 0x1d9) granted to tenant_owner/tenant_admin/account_manager/recruiting_manager/
  // lead_recruiter + tenant:admin:user-manage revoked from account_manager/recruiting_manager.
  // One guarded DO block on fixed role ids (a no-op without a role catalog). No
  // returned-shape change. AFTER the ROLES-1 role model.
  'libs/identity/prisma/migrations/20261022140000_org_ux_1_template_author_grants/migration.sql',
  // ATS-QA-1 (LOCKED §4 I-2, A4) — pipeline:resume:set Scope row ensured on seed id 0x0077
  // (I-0 F-1) + granted to every pipeline:add role. One guarded DO block on fixed role ids
  // (a no-op without a role catalog). No returned-shape change.
  'libs/identity/prisma/migrations/20261022150000_ats_qa_1_resume_select_grants/migration.sql',
  // Personal Free — GeoLite2 evidence + review-lifted phone step (additive).
  'libs/identity/prisma/migrations/20261024100000_sign_personal_geo_step_up/migration.sql',
  // CCP A1 (Aramo-CCP-A1-Commercial-Roles-and-Scopes-Directive-v1_0 LOCKED §6.4) — 6 platform-tier
  // commercial roles (0x2c0..0x2c5), 15 platform:* commercial scopes (0x326..0x334) and their 45
  // role-scope rows. Catalog only: no user holds a new role, so the effective-scope bump set is
  // empty (the block RAISEs otherwise). One guarded, fail-closed DO block on fixed ids (a no-op
  // without a role catalog). No returned-shape change, so no pact verify-api registration.
  'libs/identity/prisma/migrations/20261024120000_ccp_a1_commercial_role_catalog/migration.sql',
  // CCP-A9 — last-effective-platform_owner invariant (triggers only; splitter-safe bodies).
  'libs/identity/prisma/migrations/20261025180000_ccp_a9_platform_last_owner_invariant/migration.sql',
];

// Resolve the ordered identity migration .sql paths against a repo root. Each
// consumer computes `repoRoot` from its own __dirname (the depth differs by
// site — libs/identity/src/tests and apps/*/src/tests are 4 up; pact/provider/
// src is 3 up) and passes it here. Returns absolute paths in APPLY order.
export function resolveIdentityMigrations(repoRoot: string): string[] {
  return IDENTITY_MIGRATIONS.map((relPath) => resolve(repoRoot, relPath));
}

// ── auth-storage migration set (Inc-3 PR-3.6). ────────────────────────────────
// The libs/auth-storage schema (refresh-token store) is a DIFFERENT schema set
// from identity, applied ALONGSIDE it by the auth-service integration specs (the
// pact provider hand-lists it too). It has a single migration today; carrying it
// here as its own ordered export — the trivial extension the PR-3.6 directive
// invited — makes the NEXT auth-storage migration a one-line edit HERE rather
// than a per-spec hand-list, and keeps it cleanly SEPARATE from the identity set
// (never interleaved). Append order-safely (same Invariant 1 as above).
export const AUTH_STORAGE_MIGRATIONS: readonly string[] = [
  'libs/auth-storage/prisma/migrations/20260512100000_init_auth_storage/migration.sql',
  // Auth-Decoupling PR-1 — host auth-profile registry (additive: a new table in
  // the SAME schema, independent of RefreshToken). Applied AFTER init.
  'libs/auth-storage/prisma/migrations/20260719000000_add_host_auth_profile/migration.sql',
];

// Resolve the ordered auth-storage migration .sql paths against a repo root
// (same repoRoot contract as resolveIdentityMigrations). Apply AFTER the
// identity set — the auth-service specs seed identity first, then auth-storage.
export function resolveAuthStorageMigrations(repoRoot: string): string[] {
  return AUTH_STORAGE_MIGRATIONS.map((relPath) => resolve(repoRoot, relPath));
}
