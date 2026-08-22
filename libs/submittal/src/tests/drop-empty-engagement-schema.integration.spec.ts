import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';

// Track-2 Engagement-Residue Forward-Cleanup (R-DROP) — proof that the new forward
// migration removes the EMPTY `engagement` schema shell while leaving `submittal`
// (relocated by t2p1) intact. The `engagement` schema is created by init_submittal_model,
// evolved in-place, emptied by t2p1's SET SCHEMA relocation, and dropped here. Forward-only;
// history is untouched. pg native multi-statement query = comment-safe (splitDdl trap avoided).

const M = '../../prisma/migrations';
const CHAIN = [
  `${M}/20260523120000_init_submittal_model/migration.sql`,
  `${M}/20260523200000_add_submittal_revoke/migration.sql`,
  `${M}/20260526140602_add_submittal_event_log/migration.sql`,
  `${M}/20260527000000_rename_submittal_state_canonical/migration.sql`,
  `${M}/20260531000000_add_outbox_event/migration.sql`,
  `${M}/20260706240000_tr2a_b3b_reconcile_rekey_exemption/migration.sql`,
  `${M}/20260812120000_t2p1_relocate_submittal_to_submittal_schema/migration.sql`,
  `${M}/20260822130000_l8b1_submittal_pipeline_link/migration.sql`,
].map((p) => resolve(__dirname, p));
const DROP_MIGRATION = resolve(
  __dirname,
  `${M}/20260823120000_drop_empty_engagement_schema/migration.sql`,
);

async function schemaExists(c: Client, name: string): Promise<boolean> {
  const r = await c.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [name]);
  return r.rowCount === 1;
}
async function objectCount(c: Client, schema: string): Promise<number> {
  const r = await c.query<{ n: string }>(
    `SELECT (
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1)
     + (SELECT count(*) FROM pg_proc  p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1)
     + (SELECT count(*) FROM pg_type  t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1)
     )::text AS n`,
    [schema],
  );
  return Number(r.rows[0]!.n);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Track-2 R-DROP — drop the empty engagement schema shell (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let sql: Client;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      sql = new Client({ connectionString: container.getConnectionUri() });
      await sql.connect();
      for (const p of CHAIN) await sql.query(readFileSync(p, 'utf8'));
    }, 180_000);

    afterAll(async () => {
      await sql?.end();
      await container?.stop();
    });

    it('BEFORE: after the submittal chain, `engagement` exists but is an EMPTY shell; `submittal` holds the relocated objects', async () => {
      expect(await schemaExists(sql, 'engagement')).toBe(true);
      expect(await objectCount(sql, 'engagement')).toBe(0); // t2p1 relocated everything out
      // submittal carries the relocated, live objects.
      expect(await schemaExists(sql, 'submittal')).toBe(true);
      expect(
        (await sql.query(`SELECT to_regclass('submittal."TalentSubmittalRecord"') AS r`)).rows[0].r,
      ).not.toBeNull();
    });

    it('AFTER: the forward drop migration removes `engagement`; `submittal` is untouched', async () => {
      await sql.query(readFileSync(DROP_MIGRATION, 'utf8'));
      expect(await schemaExists(sql, 'engagement')).toBe(false);
      // submittal + its authoritative table survive the drop.
      expect(await schemaExists(sql, 'submittal')).toBe(true);
      expect(
        (await sql.query(`SELECT to_regclass('submittal."TalentSubmittalRecord"') AS r`)).rows[0].r,
      ).not.toBeNull();
    });
  },
);
