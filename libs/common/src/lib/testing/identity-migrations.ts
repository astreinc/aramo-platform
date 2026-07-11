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
// needs. This helper carries the FULL ordered set (all 11); sites that apply a
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
];

// Resolve the ordered auth-storage migration .sql paths against a repo root
// (same repoRoot contract as resolveIdentityMigrations). Apply AFTER the
// identity set — the auth-service specs seed identity first, then auth-storage.
export function resolveAuthStorageMigrations(repoRoot: string): string[] {
  return AUTH_STORAGE_MIGRATIONS.map((relPath) => resolve(repoRoot, relPath));
}
