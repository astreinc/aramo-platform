import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Sign Unified Product S-1 — envelope provenance migration on real Postgres 17.
// Applies every esign migration BEFORE 20261019160000, writes pre-existing rows
// (a Sign-authored envelope and an ATS envelope with a CORE_REF document), then
// applies the provenance migration and proves the backfill and the constraints.

const ROOT = resolve(__dirname, '../../../..');
const PROVENANCE = '20261019160000_sign_envelope_provenance';

function migrations(): { name: string; path: string }[] {
  const dir = resolve(ROOT, 'libs/esign/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => ({ name: n, path: resolve(dir, n, 'migration.sql') }));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Sign S-1 — envelope provenance migration', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  const TENANT = randomUUID();
  const ACTOR = randomUUID();
  const signEnv = randomUUID();
  const atsEnv = randomUUID();

  async function envelope(id: string): Promise<void> {
    await db.query(
      `INSERT INTO "esign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by)
       VALUES ($1,$2,'Doc','DRAFT','SINGLE_SIGNATURE',$3)`,
      [id, TENANT, ACTOR],
    );
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    const all = migrations();
    const idx = all.findIndex((m) => m.name === PROVENANCE);
    expect(idx).toBeGreaterThan(0);
    for (const m of all.slice(0, idx)) await db.query(readFileSync(m.path, 'utf8'));
    await envelope(signEnv);
    await envelope(atsEnv);
    await db.query(
      `INSERT INTO "esign"."EnvelopeDocument" (id, tenant_id, envelope_id, source_mode, document_ref, document_revision_ref, title, ordinal, source_sha256)
       VALUES ($1,$2,$3,'CORE_REF',$4,$5,'RTR',0,'abc')`,
      [randomUUID(), TENANT, atsEnv, randomUUID(), randomUUID()],
    );
    for (const m of all.slice(idx)) await db.query(readFileSync(m.path, 'utf8'));
  }, 180_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  it('backfills ATS envelopes (CORE_REF documents) as aramo-ats and leaves Sign envelopes aramo-sign', async () => {
    const r = await db.query(
      `SELECT id, source_application, installation_id, origin_actor_kind, created_by FROM "esign"."SignatureEnvelope" WHERE tenant_id = $1`,
      [TENANT],
    );
    const by = new Map(r.rows.map((x) => [x.id, x]));
    expect(by.get(atsEnv)).toMatchObject({ source_application: 'aramo-ats', installation_id: null, origin_actor_kind: 'USER', created_by: ACTOR });
    expect(by.get(signEnv)).toMatchObject({ source_application: 'aramo-sign', installation_id: null, origin_actor_kind: 'USER', created_by: ACTOR });
  });

  it('refuses an unknown actor kind and a malformed application key', async () => {
    await expect(db.query(`UPDATE "esign"."SignatureEnvelope" SET origin_actor_kind = 'ROBOT' WHERE id = $1`, [signEnv])).rejects.toThrow(/origin_actor_kind_check/);
    await expect(db.query(`UPDATE "esign"."SignatureEnvelope" SET source_application = 'Bad Key!' WHERE id = $1`, [signEnv])).rejects.toThrow(/source_application_check/);
  });

  it('indexes envelopes by (tenant, owner) for own-envelope reads', async () => {
    const r = await db.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'esign' AND indexname = 'SignatureEnvelope_tenant_id_created_by_idx'`);
    expect(r.rowCount).toBe(1);
  });
});
