import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PolicyStore,
  PrismaService,
  type PublishPolicyVersionInput,
} from '@aramo/policy-store';

import { TenantPolicyCoverageRepository } from '../policy/tenant-policy-coverage.repository.js';

// ADR-0024 PR-4a-2 — the startup coverage anti-join against real Postgres.
// Skipped unless ARAMO_RUN_INTEGRATION=1.

const ROOT = resolve(__dirname, '../../../..');
const SYSTEM_PUBLISHER = '00000000-0000-0000-0000-000000000000';
const PKG_NAME = 'requisition-lifecycle';
const COVERED = '01900000-0000-7000-8000-0000000000b1'; // active ATS + has package
const UNCOVERED = '01900000-0000-7000-8000-0000000000b2'; // active ATS + NO package
const INACTIVE = '01900000-0000-7000-8000-0000000000b3'; // inactive ATS + NO package
const SIGN_ONLY = '01900000-0000-7000-8000-0000000000b4'; // active, no ATS product + NO package
const ATS_REVOKED = '01900000-0000-7000-8000-0000000000b5'; // active, ATS revoked + NO package

function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}
const MIGRATIONS = migrationsFor('policy-store');

const PKG: PublishPolicyVersionInput['definition'] = {
  name: PKG_NAME,
  version: '1.0.0',
  registry: { resources: ['REQUISITION_TALENT'], actions: ['ADD'] },
  default_disposition: { decision: 'ALLOW', reason_code: 'X' },
  rules: [],
};

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TenantPolicyCoverageRepository anti-join (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let dbUrl = '';

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      dbUrl = container.getConnectionUri();
      db = new Client({ connectionString: dbUrl });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      // Minimal identity.Tenant — only the columns the coverage anti-join reads
      // (id, name, is_active). The full identity schema is owned by libs/identity;
      // reconstructing the three read columns keeps this test to the JOIN + active-
      // window logic under test. Column names verified against the libs/identity
      // Tenant model.
      await db.query('CREATE SCHEMA IF NOT EXISTS "identity"');
      await db.query(
        'CREATE TABLE "identity"."Tenant" (id uuid PRIMARY KEY, name text NOT NULL, is_active boolean NOT NULL DEFAULT true)',
      );
      await db.query(
        'INSERT INTO "identity"."Tenant" (id,name,is_active) VALUES ($1,$2,true),($3,$4,true),($5,$6,false),($7,$8,true),($9,$10,true)',
        [COVERED, 'Covered Co', UNCOVERED, 'Uncovered Co', INACTIVE, 'Inactive Co', SIGN_ONLY, 'Sign Only Co', ATS_REVOKED, 'Revoked Co'],
      );
      // Minimal entitlement.TenantEntitlement — the three columns the ATS-product
      // predicate reads (tenant_id, capability, revoked_at), same approach as Tenant.
      await db.query('CREATE SCHEMA IF NOT EXISTS "entitlement"');
      await db.query(
        'CREATE TABLE "entitlement"."TenantEntitlement" (tenant_id uuid NOT NULL, capability text NOT NULL, revoked_at timestamptz, PRIMARY KEY (tenant_id, capability))',
      );
      await db.query(
        `INSERT INTO "entitlement"."TenantEntitlement" (tenant_id,capability,revoked_at) VALUES
           ($1,'ats',NULL),($2,'ats',NULL),($3,'ats',NULL),($4,'sign',NULL),($5,'ats',now()),($5,'sign',NULL)`,
        [COVERED, UNCOVERED, INACTIVE, SIGN_ONLY, ATS_REVOKED],
      );
      prisma = new PrismaService(dbUrl);
      await prisma.$connect();
      await new PolicyStore(prisma).publish({
        tenant_id: COVERED,
        definition: PKG,
        published_by: SYSTEM_PUBLISHER,
      });
    }, 120_000);

    afterAll(async () => {
      await prisma?.onModuleDestroy();
      await db?.end();
      await container?.stop();
    }, 60_000);

    it('returns ONLY active ATS tenants lacking an active requisition-lifecycle package', async () => {
      const repo = new TenantPolicyCoverageRepository(dbUrl);
      try {
        const rows = await repo.findUncoveredTenants();
        const ids = rows.map((r) => r.tenant_id);
        expect(ids).toContain(UNCOVERED); // active + no package → flagged
        expect(ids).not.toContain(COVERED); // has active package → not flagged
        expect(ids).not.toContain(INACTIVE); // inactive → excluded
        expect(ids).not.toContain(SIGN_ONLY); // no ATS product → not a gap
        expect(ids).not.toContain(ATS_REVOKED); // ATS revoked → not a gap
        expect(ids).toEqual([UNCOVERED]);
        // The flagged row carries its name for the loud log.
        expect(rows.find((r) => r.tenant_id === UNCOVERED)?.tenant_name).toBe(
          'Uncovered Co',
        );
      } finally {
        await repo.onModuleDestroy();
      }
    });
  },
);
