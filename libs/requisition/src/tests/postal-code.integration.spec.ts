import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';

// WL-B1 — real-Postgres proof for the additive Requisition.postal_code column.
// Proves against Postgres 17: the migration applies; create WITH postal_code
// persists + reads back; create WITHOUT reads NULL; update round-trips. Uses raw
// SQL over the migrated schema (the requisition Prisma client's full-column read
// is separately proven by ats-batch2-requisition, which now applies this
// migration). Additive, nullable, ADD-not-rename (directive R2/R11/R14).

const ROOT = resolve(__dirname, '../../../..');
const MIGRATIONS = [
  resolve(ROOT, 'libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql'),
  resolve(ROOT, 'libs/requisition/prisma/migrations/20260907120000_add_requisition_postal_code/migration.sql'),
];

// Comment-aware splitter — drops whole `--` comment lines before splitting on
// `;` (older migrations carry `;` inside comments).
function splitDdl(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe('Requisition.postal_code — real Postgres round-trip (WL-B1)', () => {
  let container: StartedPostgreSqlContainer;
  let sql: Client;
  const tenant = randomUUID();
  const company = randomUUID();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17').start();
    sql = new Client({ connectionString: container.getConnectionUri() });
    await sql.connect();
    for (const path of MIGRATIONS) {
      for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
        await sql.query(stmt);
      }
    }
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await container?.stop();
  });

  it('migration applies — postal_code column exists and is nullable', async () => {
    const res = await sql.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'requisition' AND table_name = 'Requisition'
         AND column_name = 'postal_code'`,
    );
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].is_nullable).toBe('YES');
  });

  it('create WITH postal_code persists and reads back (city/state/postal_code)', async () => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, city, state, postal_code)
       VALUES ($1, $2, 'Role A', $3, 'Washington', 'DC', '20005')`,
      [id, tenant, company],
    );
    const r = await sql.query(
      `SELECT city, state, postal_code FROM requisition."Requisition" WHERE id = $1`,
      [id],
    );
    expect(r.rows[0]).toMatchObject({ city: 'Washington', state: 'DC', postal_code: '20005' });
  });

  it('create WITHOUT postal_code reads back NULL', async () => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id)
       VALUES ($1, $2, 'Role B', $3)`,
      [id, tenant, company],
    );
    const r = await sql.query(`SELECT postal_code FROM requisition."Requisition" WHERE id = $1`, [id]);
    expect(r.rows[0].postal_code).toBeNull();
  });

  it('update sets postal_code and reads back (update parity)', async () => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id)
       VALUES ($1, $2, 'Role C', $3)`,
      [id, tenant, company],
    );
    await sql.query(`UPDATE requisition."Requisition" SET postal_code = '20500' WHERE id = $1`, [id]);
    const r = await sql.query(`SELECT postal_code FROM requisition."Requisition" WHERE id = $1`, [id]);
    expect(r.rows[0].postal_code).toBe('20500');
  });
});
