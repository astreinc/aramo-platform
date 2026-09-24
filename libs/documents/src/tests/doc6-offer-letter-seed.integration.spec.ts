import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// DOC-6 B1 (R-6-2) — the OFFER_LETTER SYSTEM DocumentType seed on real Postgres 17.
// Evidence-only offer-letter type; Talent is the sole signer (SINGLE_SIGNATURE).

const ROOT = resolve(__dirname, '../../../..');
const OFFER_LETTER_TYPE_ID = 'd0c50006-0000-7000-8000-000000000001';

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('DOC-6 OFFER_LETTER seed — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17').start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    // pg's native multi-statement query is comment-safe (no splitDdl trap).
    for (const m of documentsMigrations()) await db.query(readFileSync(m, 'utf8'));
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  it('seeds OFFER_LETTER as a SYSTEM DocumentType (tenant_id NULL, system_defined, SINGLE_SIGNATURE, CONTRACT_RECORD)', async () => {
    const r = await db.query(
      `SELECT scope, system_defined, execution_mode_default, retention_class, active
         FROM "documents"."DocumentType" WHERE id=$1 AND key='OFFER_LETTER' AND tenant_id IS NULL`,
      [OFFER_LETTER_TYPE_ID],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].scope).toBe('SYSTEM');
    expect(r.rows[0].system_defined).toBe(true);
    expect(r.rows[0].execution_mode_default).toBe('SINGLE_SIGNATURE');
    expect(r.rows[0].retention_class).toBe('CONTRACT_RECORD');
    expect(r.rows[0].active).toBe(true);
  });

  it('coexists with the DOC-5 RIGHT_TO_REPRESENT SYSTEM type (both distinct SYSTEM rows)', async () => {
    const r = await db.query(
      `SELECT key FROM "documents"."DocumentType" WHERE tenant_id IS NULL AND scope='SYSTEM' ORDER BY key`,
    );
    const keys = r.rows.map((x) => x.key);
    expect(keys).toContain('OFFER_LETTER');
    expect(keys).toContain('RIGHT_TO_REPRESENT');
  });

  it('the seed is idempotent — re-applying the migration is a no-op (ON CONFLICT DO NOTHING)', async () => {
    const seed = documentsMigrations().find((m) => m.includes('doc6_seed_offer_letter'));
    expect(seed).toBeDefined();
    await db.query(readFileSync(seed as string, 'utf8')); // re-apply
    const r = await db.query(
      `SELECT count(*)::int AS n FROM "documents"."DocumentType" WHERE id=$1`,
      [OFFER_LETTER_TYPE_ID],
    );
    expect(r.rows[0].n).toBe(1);
  });
});
