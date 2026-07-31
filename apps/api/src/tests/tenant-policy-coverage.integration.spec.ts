import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
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
const COVERED = '01900000-0000-7000-8000-0000000000b1'; // active + has package
const UNCOVERED = '01900000-0000-7000-8000-0000000000b2'; // active + NO package
const INACTIVE = '01900000-0000-7000-8000-0000000000b3'; // inactive + NO package

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
      container = await new PostgreSqlContainer('postgres:17').start();
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
        'INSERT INTO "identity"."Tenant" (id,name,is_active) VALUES ($1,$2,true),($3,$4,true),($5,$6,false)',
        [COVERED, 'Covered Co', UNCOVERED, 'Uncovered Co', INACTIVE, 'Inactive Co'],
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

    it('returns ONLY active tenants lacking an active requisition-lifecycle package', async () => {
      const repo = new TenantPolicyCoverageRepository(dbUrl);
      try {
        const rows = await repo.findUncoveredTenants();
        const ids = rows.map((r) => r.tenant_id);
        expect(ids).toContain(UNCOVERED); // active + no package → flagged
        expect(ids).not.toContain(COVERED); // has active package → not flagged
        expect(ids).not.toContain(INACTIVE); // inactive → excluded
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
