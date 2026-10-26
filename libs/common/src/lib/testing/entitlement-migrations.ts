import { resolve } from 'node:path';

// CCP-A7 — the shared entitlement migration-registration helper (CLAUDE.md shared-helper law;
// the identity-migrations.ts precedent). CCP-A7 adds columns the EntitlementRepository reads and
// writes (revoked_at, granted_source, …), so every integration spec that boots a real
// entitlement store must apply the full entitlement set, not only the init migration. This is
// the single ordered source of truth: the NEXT entitlement migration is a one-line edit HERE.
//
// Apply in ARRAY order, whole-file, after (or independently of) the identity set: the entitlement
// schema has no cross-schema dependency. Every entry is replay-safe or a no-op on re-apply except
// the init (CREATE TYPE), so apply the set once per fresh database.
export const ENTITLEMENT_MIGRATIONS: readonly string[] = [
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
  'libs/entitlement/prisma/migrations/20260923173000_add_esign_capability/migration.sql',
  'libs/entitlement/prisma/migrations/20261020130000_sign_naming_capability/migration.sql',
  'libs/entitlement/prisma/migrations/20261024150000_add_intelligence_capability/migration.sql',
  // CCP-A7 — provenance, the governed revoke, the ledger and the resurrection guard (splitter-safe).
  'libs/entitlement/prisma/migrations/20261026000000_ccp_a7_entitlement_revoke_provenance/migration.sql',
];

/** The CCP-A7 migration alone (for specs that hand-list the earlier entitlement DDL). */
export const ENTITLEMENT_PROVENANCE_MIGRATION = ENTITLEMENT_MIGRATIONS[ENTITLEMENT_MIGRATIONS.length - 1] as string;

// Resolve the ordered entitlement migration .sql paths against a repo root (same repoRoot
// contract as resolveIdentityMigrations). Returns absolute paths in APPLY order.
export function resolveEntitlementMigrations(repoRoot: string): string[] {
  return ENTITLEMENT_MIGRATIONS.map((relPath) => resolve(repoRoot, relPath));
}

// CCP-R1 (TD-A7-3, Architect program acceptance disposition) — granted_source has NO database
// default: every write to entitlement."TenantEntitlement" names its source, fixtures included
// (the source scan libs/entitlement/src/tests/ccp-r1-granted-source-scan.spec.ts enforces it).
// The fixture helper takes the source as a required argument. Only the non-commercial sources are
// offered: a commercial source (MANUAL, PLAN, PROMOTION) needs a governed change request (DB
// CHECK), which a fixture never fakes; MIGRATION is for a fixture that models pre-A7 history.
export const FIXTURE_GRANTED_SOURCES = ['PROVISIONING', 'SIGNUP', 'MIGRATION'] as const;
export type FixtureGrantedSource = (typeof FIXTURE_GRANTED_SOURCES)[number];

/** The fixture grant statement: $1 tenant uuid, $2 text[] of capabilities; an existing row is left as it is. */
export function tenantEntitlementFixtureSql(granted_source: FixtureGrantedSource): string {
  if (!(FIXTURE_GRANTED_SOURCES as readonly string[]).includes(granted_source)) {
    throw new Error(`tenantEntitlementFixtureSql: granted_source must be one of ${FIXTURE_GRANTED_SOURCES.join(', ')}`);
  }
  return `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source)
     SELECT $1::uuid, c::entitlement."Capability", '${granted_source}' FROM unnest($2::text[]) AS c
     ON CONFLICT (tenant_id, capability) DO NOTHING`;
}

/** Grant fixture capabilities to one tenant with an explicit, required source. */
export async function seedTenantEntitlements(
  query: (sql: string, params?: unknown[]) => Promise<unknown>,
  args: { tenant_id: string; capabilities: readonly string[]; granted_source: FixtureGrantedSource },
): Promise<void> {
  await query(tenantEntitlementFixtureSql(args.granted_source), [args.tenant_id, [...args.capabilities]]);
}
