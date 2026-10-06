import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Offer & Start Journey directive §5.3 — the three pre-start governed SYSTEM
// DocumentTypes (Client NDA, Background Authorization, I-9) the approved UX
// surfaces must exist after the documents migrations run, talent-signed and
// system-defined, with deterministic fixed ids, and the seed must be idempotent.
// Non-vacuous: without the seed migration the first assertion sees zero rows.

const ROOT = resolve(__dirname, '../../../..');
const MIG_DIR = resolve(ROOT, 'libs/documents/prisma/migrations');
const SEED_MIG = resolve(MIG_DIR, '20261005120000_offer_start_seed_prestart_document_types/migration.sql');

const EXPECTED = [
  { id: 'd0c50007-0000-7000-8000-000000000001', key: 'CLIENT_NDA' },
  { id: 'd0c50007-0000-7000-8000-000000000002', key: 'BACKGROUND_AUTHORIZATION' },
  { id: 'd0c50007-0000-7000-8000-000000000003', key: 'I9' },
];

function documentsMigrations(): string[] {
  return readdirSync(MIG_DIR)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(MIG_DIR, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Offer & Start §5.3 — pre-start SYSTEM DocumentType seeds (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      db = new Client({ connectionString: container.getConnectionUri() });
      await db.connect();
      for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));
    }, 120_000);

    afterAll(async () => {
      await db?.end();
      await container?.stop();
    });

    it('seeds exactly the three SYSTEM pre-start document types — talent-signed, system-defined, active, tenant-null, fixed ids', async () => {
      const { rows } = await db.query(
        `SELECT id, key, scope, execution_mode_default, system_defined, active, tenant_id
           FROM "documents"."DocumentType"
          WHERE key = ANY($1)
          ORDER BY key`,
        [EXPECTED.map((e) => e.key)],
      );
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r.scope).toBe('SYSTEM');
        expect(r.execution_mode_default).toBe('SINGLE_SIGNATURE');
        expect(r.system_defined).toBe(true);
        expect(r.active).toBe(true);
        expect(r.tenant_id).toBeNull();
      }
      const byKey = Object.fromEntries(rows.map((r) => [r.key, r.id]));
      for (const e of EXPECTED) expect(byKey[e.key]).toBe(e.id);
    });

    it('is idempotent — re-applying the seed migration changes nothing (ON CONFLICT DO NOTHING)', async () => {
      await db.query(readFileSync(SEED_MIG, 'utf8'));
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM "documents"."DocumentType" WHERE key = ANY($1)`,
        [EXPECTED.map((e) => e.key)],
      );
      expect(rows[0].n).toBe(3);
    });
  },
);
