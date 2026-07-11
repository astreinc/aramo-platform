// Inc-3 PR-3.7 — shared test seed for the global TenantWriteFreezeInterceptor.
//
// The interceptor (registered first in apps/api) reads identity.Tenant.status on
// EVERY authenticated mutation and refuses SUSPENDED/CLOSED (and fails closed on a
// missing tenant row). Every apps/api integration spec that forges a JWT and
// drives a mutation therefore now needs an identity.Tenant row — with the status
// column — for its forged tenant_id, seeded to a NON-denying status. Most specs
// seed only their own domain schema with a bare tenant_id uuid, so this helper
// backfills the minimum the interceptor needs, idempotently, regardless of what
// the spec already applied:
//
//   - CREATE the identity.Tenant table IF it doesn't exist (specs with no identity
//     migrations) with just the columns findLifecycleById selects (id/status/
//     is_active) + the NOT-NULL scaffolding a raw insert needs.
//   - ADD the status / is_active columns IF a real identity.Tenant table exists but
//     its frozen migration list predates add_tenant_lifecycle_status.
//   - UPSERT an ACTIVE (default) tenant row for the forged tenant_id.
//
// Parameterized on tenant_id and status: a spec that legitimately needs a
// non-ACTIVE tenant (e.g. asserting the freeze itself) passes the status. The
// tenant_id/status are test-forged constants, so inlining them is injection-safe.
//
// `runSql` adapts to each spec's DB access: pg → (s) => client.query(s); Prisma →
// (s) => prisma.$executeRawUnsafe(s).
export type TenantWriteFreezeStatus =
  | 'PROVISIONED'
  | 'ACTIVE'
  | 'OFFBOARDING'
  | 'SUSPENDED'
  | 'CLOSED';

export async function ensureWriteFreezeTenant(
  runSql: (sql: string) => Promise<unknown>,
  tenantId: string,
  status: TenantWriteFreezeStatus = 'ACTIVE',
): Promise<void> {
  await runSql(`CREATE SCHEMA IF NOT EXISTS identity`);
  await runSql(
    `CREATE TABLE IF NOT EXISTS identity."Tenant" (
       id uuid PRIMARY KEY,
       name text NOT NULL DEFAULT 'write-freeze-test',
       is_active boolean NOT NULL DEFAULT true,
       status text NOT NULL DEFAULT 'PROVISIONED',
       created_at timestamptz NOT NULL DEFAULT now(),
       updated_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  // Real table present but pre-lifecycle-status list → add the columns the
  // interceptor's findLifecycleById reads. No-ops when they already exist.
  await runSql(
    `ALTER TABLE identity."Tenant" ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'PROVISIONED'`,
  );
  await runSql(
    `ALTER TABLE identity."Tenant" ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`,
  );
  await runSql(
    `INSERT INTO identity."Tenant" (id, name, status, is_active, updated_at)
       VALUES ('${tenantId}', 'write-freeze-test', '${status}', true, now())
     ON CONFLICT (id) DO UPDATE SET status = '${status}', is_active = true`,
  );
}
