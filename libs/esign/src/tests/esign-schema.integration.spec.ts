import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// DOC-3 boundary 1 — esign schema/trigger proofs on real Postgres 17. The esign
// schema is self-contained (Documents refs are opaque UUIDs, no FK), so this
// globs ONLY the module's own migrations.

const ROOT = resolve(__dirname, '../../../..');

function esignMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/esign/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('DOC-3 esign schema — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;

  const TENANT = randomUUID();
  const ACTOR = randomUUID();

  async function newEnvelope(status = 'DRAFT'): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO "esign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by)
       VALUES ($1,$2,'Offer letter',$3,'SINGLE_SIGNATURE',$4)`,
      [id, TENANT, status, ACTOR],
    );
    return id;
  }

  async function appendEvent(envelopeId: string, prevHash: string | null, hash: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO "esign"."SignatureEvent" (id, tenant_id, envelope_id, event_type, actor_type, previous_event_hash, event_hash)
       VALUES ($1,$2,$3,'ENVELOPE_CREATED','SYSTEM',$4,$5)`,
      [id, TENANT, envelopeId, prevHash, hash],
    );
    return id;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17').start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    for (const m of esignMigrations()) await db.query(readFileSync(m, 'utf8'));
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  it('creates the esign schema with the twelve tables', async () => {
    const r = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'esign'`,
    );
    // Collation-independent set comparison.
    expect([...r.rows.map((x) => x.table_name)].sort()).toEqual(
      [
        'EnvelopeDocument',
        'ExecutedDocument', // DOC-4 (R-4-3)
        'ExecutionCertificate', // DOC-4 (R-4-6)
        'IdempotencyKey',
        'NotificationDelivery',
        'OutboxEvent',
        'Signer',
        'SignatureEnvelope',
        'SignatureEvent',
        'SignatureField',
        'SignerDisclosureAcceptance',
        'SigningSession',
      ].sort(),
    );
  });

  it('rejects an invalid envelope status (CHECK vocab)', async () => {
    await expect(newEnvelope('NONSENSE')).rejects.toThrow(/status_check|violates check/i);
  });

  it('SignatureEvent is append-only: UPDATE and DELETE are rejected', async () => {
    const env = await newEnvelope();
    const evId = await appendEvent(env, null, 'h0');
    await expect(
      db.query(`UPDATE "esign"."SignatureEvent" SET event_type = 'X' WHERE id = $1`, [evId]),
    ).rejects.toThrow(/append-only/i);
    await expect(db.query(`DELETE FROM "esign"."SignatureEvent" WHERE id = $1`, [evId])).rejects.toThrow(/append-only/i);
  });

  it('records a hash chain across events (previous_event_hash links)', async () => {
    const env = await newEnvelope();
    await appendEvent(env, null, 'hash-a');
    await appendEvent(env, 'hash-a', 'hash-b');
    const r = await db.query(
      `SELECT previous_event_hash, event_hash FROM "esign"."SignatureEvent" WHERE envelope_id = $1 ORDER BY occurred_at`,
      [env],
    );
    // The second event chains from the first.
    const chained = r.rows.find((x) => x.event_hash === 'hash-b');
    expect(chained?.previous_event_hash).toBe('hash-a');
  });

  it('enforces the signer signing_order unique tuple per envelope', async () => {
    const env = await newEnvelope();
    const mkSigner = (order: number) =>
      db.query(
        `INSERT INTO "esign"."Signer" (id, tenant_id, envelope_id, email, name, signing_order, status)
         VALUES ($1,$2,$3,'a@b.com','A',$4,'PENDING')`,
        [randomUUID(), TENANT, env, order],
      );
    await mkSigner(1);
    await expect(mkSigner(1)).rejects.toThrow(/unique|duplicate/i);
  });

  it('stores only a SigningSession token hash (unique), never a raw token column', async () => {
    const env = await newEnvelope();
    const signerId = randomUUID();
    await db.query(
      `INSERT INTO "esign"."Signer" (id, tenant_id, envelope_id, email, name, signing_order, status)
       VALUES ($1,$2,$3,'a@b.com','A',1,'PENDING')`,
      [signerId, TENANT, env],
    );
    const cols = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='esign' AND table_name='SigningSession'`,
    );
    const names = cols.rows.map((x) => x.column_name);
    expect(names).toContain('token_hash');
    expect(names).not.toContain('token');
    expect(names).not.toContain('raw_token');
  });
});
