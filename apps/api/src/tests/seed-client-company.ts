// Company Party/Role (ADR-0032, R7) — shared test seed for the CLIENT-workflow
// invariant. The requisition create guard (CompanyClientCheckPort → apps/api
// adapter → CompanyRepository.hasClientRelationship) now fail-closed rejects a
// POST /v1/requisitions whose company_id has no CLIENT CompanyRelationship.
//
// Many req-create integration specs reference a SYNTHETIC company_id uuid that
// was never inserted as a Company (the pre-party/role code never validated it).
// This helper backfills the minimum the guard needs, idempotently, regardless
// of whether the spec's migration list includes the company schema:
//
//   - CREATE the company schema + minimal Company / CompanyRelationship tables
//     IF they don't exist (specs with no company migrations). When the real
//     tables are present (party-role migration applied) these are no-ops.
//   - UPSERT a Company row + an ACTIVE CLIENT relationship for the company_id.
//
// tenant_id/company_id are test-forged constants, so inlining them is
// injection-safe (mirrors write-freeze-tenant.ts). `runSql` adapts to each
// spec's DB access: pg → (s) => client.query(s); Prisma → (s) =>
// prisma.$executeRawUnsafe(s).
type RunSql = (sql: string) => Promise<unknown>;

// Seed a company with ONE relationship of the given type/status. The building
// block for both the CLIENT happy-path seed and the VENDOR-only negative seed
// (R7 rejects a requisition create whose company has no CLIENT relationship).
async function seedCompanyWithRelationship(
  runSql: RunSql,
  tenantId: string,
  companyId: string,
  type: 'CLIENT' | 'VENDOR' | 'PARTNER',
  status: string,
  name: string,
): Promise<void> {
  await runSql(`CREATE SCHEMA IF NOT EXISTS company`);
  // Minimal Company (composite-FK target for CompanyRelationship). A real
  // company.Company created by the migration has these + more (defaulted)
  // columns, so CREATE IF NOT EXISTS is a no-op and the insert below relies on
  // the DB defaults for the omitted NOT-NULL columns.
  await runSql(
    `CREATE TABLE IF NOT EXISTS company."Company" (
       id uuid PRIMARY KEY,
       tenant_id uuid NOT NULL,
       name text NOT NULL DEFAULT 'seed-client-co',
       created_at timestamptz NOT NULL DEFAULT now(),
       updated_at timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT "Company_tenant_id_id_key" UNIQUE (tenant_id, id)
     )`,
  );
  await runSql(
    `CREATE TABLE IF NOT EXISTS company."CompanyRelationship" (
       id uuid PRIMARY KEY,
       tenant_id uuid NOT NULL,
       company_id uuid NOT NULL,
       type text NOT NULL,
       status text NOT NULL,
       effective_from timestamptz,
       effective_to timestamptz,
       created_at timestamptz NOT NULL DEFAULT now(),
       updated_at timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT "CompanyRelationship_tenant_id_company_id_type_key"
         UNIQUE (tenant_id, company_id, type)
     )`,
  );
  await runSql(
    `INSERT INTO company."Company" (id, tenant_id, name)
       VALUES ('${companyId}', '${tenantId}', '${name}')
     ON CONFLICT (id) DO NOTHING`,
  );
  await runSql(
    `INSERT INTO company."CompanyRelationship" (id, tenant_id, company_id, type, status)
       VALUES (gen_random_uuid(), '${tenantId}', '${companyId}', '${type}', '${status}')
     ON CONFLICT (tenant_id, company_id, type) DO NOTHING`,
  );
}

// Happy path: a company with an ACTIVE CLIENT relationship — requisition create
// is permitted (R7 satisfied).
export async function ensureClientCompany(
  runSql: RunSql,
  tenantId: string,
  companyId: string,
  name = 'seed-client-co',
): Promise<void> {
  await seedCompanyWithRelationship(runSql, tenantId, companyId, 'CLIENT', 'ACTIVE', name);
}

// Negative case: a company that EXISTS but carries only a VENDOR relationship —
// no CLIENT. Requisition create against it must fail-closed (R7), and the
// failure is specifically "not a client", not "company not found".
export async function ensureVendorOnlyCompany(
  runSql: RunSql,
  tenantId: string,
  companyId: string,
  name = 'seed-vendor-co',
): Promise<void> {
  await seedCompanyWithRelationship(runSql, tenantId, companyId, 'VENDOR', 'ACTIVE', name);
}
