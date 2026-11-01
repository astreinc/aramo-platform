import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Feature-Parity §1.16 / §1.19 (Amendment A1) — migration 20261101310000 on real Postgres 17:
// the QES and e-stamp tables' CHECKs, the SIGNED-immutability trigger, the one-live-order
// index and the cascades.

const ROOT = resolve(__dirname, '../../../..');

function migrations(): string[] {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Feature-Parity A1 — QES / e-stamp schema', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  const TENANT = randomUUID();
  const ACTOR = randomUUID();

  async function envelope(): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by) VALUES ($1,$2,'Deed','DRAFT','SINGLE_SIGNATURE',$3)`,
      [id, TENANT, ACTOR],
    );
    return id;
  }
  async function signer(env: string): Promise<string> {
    const id = randomUUID();
    await db.query(`INSERT INTO "sign"."Signer" (id, tenant_id, envelope_id, email, name, signing_order, status) VALUES ($1,$2,$3,'a@b.com','A',1,'PENDING')`, [id, TENANT, env]);
    return id;
  }
  async function document(env: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO "sign"."EnvelopeDocument" (id, tenant_id, envelope_id, source_mode, source_object_key, title, source_sha256, ordinal) VALUES ($1,$2,$3,'OWNED','k','e-Stamp','sha',0)`,
      [id, TENANT, env],
    );
    return id;
  }
  async function qes(env: string, sig: string): Promise<string> {
    const id = randomUUID();
    await db.query(`INSERT INTO "sign"."SignQesSignature" (id, tenant_id, envelope_id, signer_id, requested_by) VALUES ($1,$2,$3,$4,$5)`, [id, TENANT, env, sig, ACTOR]);
    return id;
  }
  async function order(env: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO "sign"."SignEstampOrder" (id, tenant_id, envelope_id, provider, state_code, article_code, stamp_duty_amount_paise, first_party, second_party, purchaser, requested_by)
       VALUES ($1,$2,$3,'stub','IN-KA','Article 5(J)',20000,'A','B','A',$4)`,
      [id, TENANT, env, ACTOR],
    );
    return id;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    for (const m of migrations()) await db.query(readFileSync(m, 'utf8'));
  }, 240_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  it('QES: defaults to REQUIRED/QES and allows one row per signer', async () => {
    const env = await envelope();
    const sig = await signer(env);
    const id = await qes(env, sig);
    const r = await db.query(`SELECT state, signature_level, certificate_chain_pem FROM "sign"."SignQesSignature" WHERE id = $1`, [id]);
    expect(r.rows[0]).toEqual({ state: 'REQUIRED', signature_level: 'QES', certificate_chain_pem: [] });
    await expect(qes(env, sig)).rejects.toThrow(/SignQesSignature_signer_id_key/);
  });

  it('QES: AUTHORIZED / SIGNED / FAILED need their evidence', async () => {
    const env = await envelope();
    const id = await qes(env, await signer(env));
    await expect(db.query(`UPDATE "sign"."SignQesSignature" SET state = 'AUTHORIZED' WHERE id = $1`, [id])).rejects.toThrow(/SignQesSignature_authorized_check/);
    await expect(db.query(`UPDATE "sign"."SignQesSignature" SET state = 'FAILED' WHERE id = $1`, [id])).rejects.toThrow(/SignQesSignature_failed_check/);
    await expect(db.query(`UPDATE "sign"."SignQesSignature" SET state = 'BOGUS' WHERE id = $1`, [id])).rejects.toThrow(/SignQesSignature_state_check/);
    await db.query(
      `UPDATE "sign"."SignQesSignature" SET state = 'AUTHORIZED', credential_id = 'c', certificate_chain_pem = ARRAY['pem'], certificate_chain_sha256 = 'h', authorized_at = now() WHERE id = $1`,
      [id],
    );
    await expect(db.query(`UPDATE "sign"."SignQesSignature" SET state = 'SIGNED' WHERE id = $1`, [id])).rejects.toThrow(/SignQesSignature_signed_check/);
  });

  it('QES: a SIGNED row is immutable', async () => {
    const env = await envelope();
    const id = await qes(env, await signer(env));
    await db.query(
      `UPDATE "sign"."SignQesSignature" SET state = 'SIGNED', credential_id = 'c', certificate_chain_pem = ARRAY['pem'], certificate_chain_sha256 = 'h', authorized_at = now(),
         signature_value_b64 = 's', signature_sha256 = 'ss', signed_digest_b64 = 'd', hash_algorithm_oid = 'h', signature_algorithm_oid = 'a', signed_at = now() WHERE id = $1`,
      [id],
    );
    await expect(db.query(`UPDATE "sign"."SignQesSignature" SET qtsp_reference = 'x' WHERE id = $1`, [id])).rejects.toThrow(/SIGNED and immutable/);
  });

  it('QES: the row goes with its signer', async () => {
    const env = await envelope();
    const sig = await signer(env);
    const id = await qes(env, sig);
    await db.query(`DELETE FROM "sign"."Signer" WHERE id = $1`, [sig]);
    expect((await db.query(`SELECT 1 FROM "sign"."SignQesSignature" WHERE id = $1`, [id])).rowCount).toBe(0);
  });

  it('e-stamp: validates the state code, duty and lifecycle evidence', async () => {
    const id = await order(await envelope());
    await expect(db.query(`UPDATE "sign"."SignEstampOrder" SET state_code = 'KA' WHERE id = $1`, [id])).rejects.toThrow(/SignEstampOrder_state_code_check/);
    await expect(db.query(`UPDATE "sign"."SignEstampOrder" SET stamp_duty_amount_paise = 0 WHERE id = $1`, [id])).rejects.toThrow(/SignEstampOrder_duty_check/);
    await expect(db.query(`UPDATE "sign"."SignEstampOrder" SET state = 'ORDERED' WHERE id = $1`, [id])).rejects.toThrow(/SignEstampOrder_ordered_check/);
    await db.query(`UPDATE "sign"."SignEstampOrder" SET state = 'ORDERED', provider_order_ref = 'p', ordered_at = now() WHERE id = $1`, [id]);
    await expect(db.query(`UPDATE "sign"."SignEstampOrder" SET state = 'ISSUED' WHERE id = $1`, [id])).rejects.toThrow(/SignEstampOrder_issued_check/);
  });

  it('e-stamp: at most one live order per envelope; a FAILED one may be followed by another', async () => {
    const env = await envelope();
    const first = await order(env);
    await expect(order(env)).rejects.toThrow(/SignEstampOrder_live_envelope_key/);
    await db.query(`UPDATE "sign"."SignEstampOrder" SET state = 'FAILED', failure_reason = 'x', failed_at = now() WHERE id = $1`, [first]);
    await expect(order(env)).resolves.toBeTypeOf('string');
  });

  it('e-stamp: removing the attached document clears the link', async () => {
    const env = await envelope();
    const doc = await document(env);
    const id = await order(env);
    await db.query(
      `UPDATE "sign"."SignEstampOrder" SET state = 'ATTACHED', provider_order_ref = 'p', ordered_at = now(), certificate_number = 'IN-KA1', certificate_issued_at = now(),
         certificate_sha256 = 's', certificate_object_key = 'k', certificate_page_count = 1, attached_document_id = $2, attached_at = now() WHERE id = $1`,
      [id, doc],
    );
    await db.query(`DELETE FROM "sign"."EnvelopeDocument" WHERE id = $1`, [doc]);
    const r = await db.query(`SELECT state, attached_document_id FROM "sign"."SignEstampOrder" WHERE id = $1`, [id]);
    expect(r.rows[0]).toEqual({ state: 'ATTACHED', attached_document_id: null });
  });
});
