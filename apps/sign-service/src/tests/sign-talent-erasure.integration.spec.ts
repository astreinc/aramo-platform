import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app/app.module.js';

// Aramo-Sign-Domain-Isolation-Reconciliation-V1-Directive-v1_0-LOCKED §2 R-3/R-6, §4 D-1/D-2 —
// the Sign-owned talent-erasure contract, on real Postgres 17 with the real AppModule and
// every Sign-side migration. Proves:
//   - authentication: only the first-party aramo-ats client credential (HTTP Basic); no or a
//     wrong credential → 401, another application's credential → 403; nothing is read or
//     deleted for a refused caller;
//   - preflight: an envelope over a talent document, an unpublished outbox event naming the
//     talent and a tenant legal hold each block; another tenant's rows never count;
//   - erase: deletes exactly the replay caches and the DELIVERED outbox events naming the
//     records in THIS tenant; signing evidence (envelopes, envelope documents, signers,
//     ledger events) is untouched; a blocker deletes nothing; a repeat deletes nothing.

const ROOT = resolve(__dirname, '../../../..');
const migrationsOf = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};
const digest = (raw: string): string => createHash('sha256').update(raw, 'utf8').digest('base64url');
const basic = (id: string, secret: string): string => `Basic ${Buffer.from(`${id}:${secret}`, 'utf8').toString('base64')}`;

const ATS_ID = 'sgc_iso_ats';
const ATS_SECRET = 'sgs_iso_ats_secret_0123456789abcdefghijklmnopqrs';
const OTHER_ID = 'sgc_iso_other';
const OTHER_SECRET = 'sgs_iso_other_secret_0123456789abcdefghijklmnopq';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('sign-service — talent-erasure contract (Domain Isolation V1, real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let module: TestingModule;
  let app: NestExpressApplication;
  const saved: Record<string, string | undefined> = {};

  const n = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ n: number }>(sql, params)).rows[0]?.n ?? 0);
  const http = () => request(app.getHttpServer());
  const ATS = basic(ATS_ID, ATS_SECRET);

  async function tenant(legal_hold = false): Promise<string> {
    const id = randomUUID();
    await db.query(`INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, legal_hold, updated_at) VALUES ($1,$2,$3,'BUSINESS','ACTIVE',true,$4, now())`, [
      id,
      `T ${id.slice(0, 8)}`,
      `t-${id.slice(0, 8)}`,
      legal_hold,
    ]);
    return id;
  }

  // An envelope (with one signer and one ledger event) over a CORE_REF document.
  async function envelopeOver(tenant_id: string, document_ref: string): Promise<string> {
    const env = randomUUID();
    await db.query(
      `INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by) VALUES ($1,$2,'Right to Represent','SENT','SINGLE_SIGNATURE',$3)`,
      [env, tenant_id, randomUUID()],
    );
    await db.query(
      `INSERT INTO "sign"."EnvelopeDocument" (id, tenant_id, envelope_id, document_ref, document_revision_ref, title, source_sha256, ordinal) VALUES ($1,$2,$3,$4,$5,'RTR',$6,1)`,
      [randomUUID(), tenant_id, env, document_ref, randomUUID(), 'a'.repeat(64)],
    );
    await db.query(`INSERT INTO "sign"."Signer" (id, tenant_id, envelope_id, name, email, signing_order, status) VALUES ($1,$2,$3,'Ada','ada@example.test',1,'PENDING')`, [
      randomUUID(),
      tenant_id,
      env,
    ]);
    return env;
  }

  async function cacheRows(tenant_id: string, record: string, tag: string): Promise<void> {
    const body = JSON.stringify({ talent_record_id: record, tag });
    await db.query(`INSERT INTO "sign"."IdempotencyKey" (id, tenant_id, key, request_hash, response_status, response_body) VALUES ($1,$2,$3,'h',201,$4::jsonb)`, [
      randomUUID(),
      tenant_id,
      `k-${tag}-${randomUUID()}`,
      body,
    ]);
    await db.query(
      `INSERT INTO "sign"."SignIdempotencyKey" (id, tenant_id, actor_id, operation, key, request_hash, response_status, response_body) VALUES ($1,$2,$3,'envelope.create',$4,'h',201,$5::jsonb)`,
      [randomUUID(), tenant_id, randomUUID(), `k-${tag}-${randomUUID()}`, body],
    );
    await db.query(`INSERT INTO "sign"."OutboxEvent" (id, tenant_id, event_type, event_payload, published_at) VALUES ($1,$2,'sign.envelope.created.v1',$3::jsonb, now())`, [
      randomUUID(),
      tenant_id,
      body,
    ]);
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const lib of ['sign', 'identity', 'entitlement', 'metering', 'subscription', 'auth-storage']) {
      for (const m of migrationsOf(lib)) await db.query(readFileSync(m, 'utf8'));
    }
    // The first-party ATS client (an application-level credential, as provisioned on the box)
    // and a third-party application's credential.
    await db.query(`INSERT INTO "sign"."SignCredential" (id, application_id, installation_id, client_id, secret_hash) SELECT $1, a.id, NULL, $2, $3 FROM "sign"."SignApplication" a WHERE a.key = 'aramo-ats'`, [
      randomUUID(),
      ATS_ID,
      digest(ATS_SECRET),
    ]);
    const other = randomUUID();
    await db.query(`INSERT INTO "sign"."SignApplication" (id, key, name, kind) VALUES ($1, 'iso-third-party', 'Third party', 'THIRD_PARTY')`, [other]);
    await db.query(`INSERT INTO "sign"."SignCredential" (id, application_id, installation_id, client_id, secret_hash) VALUES ($1,$2,NULL,$3,$4)`, [randomUUID(), other, OTHER_ID, digest(OTHER_SECRET)]);

    for (const k of ['DATABASE_URL', 'MAILER_PROVIDER', 'REDIS_URL']) saved[k] = process.env[k];
    process.env['DATABASE_URL'] = url;
    process.env['MAILER_PROVIDER'] = 'stub';
    delete process.env['REDIS_URL'];
    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await container?.stop();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }, 60_000);

  it('authenticates ONLY the first-party ATS client; a refused caller reads and deletes nothing', async () => {
    const t = await tenant();
    const rec = randomUUID();
    await cacheRows(t, rec, 'auth');
    const body = { tenant_id: t, run_id: randomUUID(), record_ids: [rec], document_refs: [] };
    const none = await http().post('/v1/sign/s2s/talent-erasure/erase').send(body);
    const wrong = await http().post('/v1/sign/s2s/talent-erasure/erase').set('Authorization', basic(ATS_ID, 'sgs_wrong')).send(body);
    const other = await http().post('/v1/sign/s2s/talent-erasure/erase').set('Authorization', basic(OTHER_ID, OTHER_SECRET)).send(body);
    const otherPreflight = await http().post('/v1/sign/s2s/talent-erasure/preflight').set('Authorization', basic(OTHER_ID, OTHER_SECRET)).send(body);
    expect([none.status, wrong.status, other.status, otherPreflight.status]).toEqual([401, 401, 403, 403]);
    expect(await n(`SELECT count(*)::int AS n FROM "sign"."IdempotencyKey" WHERE tenant_id = $1`, [t])).toBe(1);
    expect(await n(`SELECT count(*)::int AS n FROM "sign"."OutboxEvent" WHERE tenant_id = $1`, [t])).toBe(1);
  });

  it('validates the scope (UUIDs, bounded lists)', async () => {
    const bad = await http().post('/v1/sign/s2s/talent-erasure/preflight').set('Authorization', ATS).send({ tenant_id: 'x', record_ids: [] });
    const badIds = await http().post('/v1/sign/s2s/talent-erasure/preflight').set('Authorization', ATS).send({ tenant_id: randomUUID(), record_ids: ['nope'] });
    const noRun = await http().post('/v1/sign/s2s/talent-erasure/erase').set('Authorization', ATS).send({ tenant_id: randomUUID(), record_ids: [] });
    expect([bad.status, badIds.status, noRun.status]).toEqual([400, 400, 400]);
  });

  it('preflight: envelope over a talent document, undelivered outbox and legal hold block; other tenants never count', async () => {
    const t = await tenant();
    const elsewhere = await tenant();
    const rec = randomUUID();
    const doc = randomUUID();
    const clean = await http().post('/v1/sign/s2s/talent-erasure/preflight').set('Authorization', ATS).send({ tenant_id: t, record_ids: [rec], document_refs: [doc] });
    expect(clean.status).toBe(200);
    expect(clean.body.holders).toEqual([]);

    // The same document id under another tenant's envelope is not this tenant's holder.
    await envelopeOver(elsewhere, doc);
    expect((await http().post('/v1/sign/s2s/talent-erasure/preflight').set('Authorization', ATS).send({ tenant_id: t, record_ids: [rec], document_refs: [doc] })).body.holders).toEqual([]);

    await envelopeOver(t, doc);
    await db.query(`INSERT INTO "sign"."OutboxEvent" (id, tenant_id, event_type, event_payload) VALUES ($1,$2,'sign.envelope.sent.v1',$3::jsonb)`, [
      randomUUID(),
      t,
      JSON.stringify({ talent_record_id: rec }),
    ]);
    await cacheRows(t, rec, 'pre');
    const blocked = await http().post('/v1/sign/s2s/talent-erasure/preflight').set('Authorization', ATS).send({ tenant_id: t, record_ids: [rec], document_refs: [doc] });
    expect(blocked.body.holders.map((h: { classification: string; count: number }) => [h.classification, h.count])).toEqual([
      ['PENDING_PO_LEGAL', 1],
      ['PENDING_OUTBOX_DRAIN', 1],
    ]);
    expect(blocked.body.erasable).toEqual({ idempotency_keys: 1, api_idempotency_keys: 1, outbox_events: 1 });

    const held = await tenant(true);
    const h = await http().post('/v1/sign/s2s/talent-erasure/preflight').set('Authorization', ATS).send({ tenant_id: held, record_ids: [rec], document_refs: [] });
    expect(h.body.holders.map((x: { classification: string }) => x.classification)).toEqual(['LEGAL_HOLD']);
  });

  it('erase: deletes exactly the caches and delivered events naming the records in this tenant; evidence untouched; idempotent', async () => {
    const t = await tenant();
    const elsewhere = await tenant();
    const rec = randomUUID();
    const bystander = randomUUID();
    const doc = randomUUID();
    const env = await envelopeOver(t, randomUUID()); // an envelope of this tenant over ANOTHER document
    await db.query(`INSERT INTO "sign"."SignatureEvent" (id, tenant_id, envelope_id, event_type, actor_type, event_hash) VALUES ($1,$2,$3,'ENVELOPE_SENT','SYSTEM',$4)`, [randomUUID(), t, env, 'b'.repeat(64)]);
    await cacheRows(t, rec, 'mine');
    await cacheRows(t, bystander, 'bystander');
    await cacheRows(elsewhere, rec, 'elsewhere');
    const evidence = async (): Promise<number[]> => [
      await n(`SELECT count(*)::int AS n FROM "sign"."SignatureEnvelope" WHERE tenant_id = $1`, [t]),
      await n(`SELECT count(*)::int AS n FROM "sign"."EnvelopeDocument" WHERE tenant_id = $1`, [t]),
      await n(`SELECT count(*)::int AS n FROM "sign"."Signer" WHERE tenant_id = $1`, [t]),
      await n(`SELECT count(*)::int AS n FROM "sign"."SignatureEvent" WHERE tenant_id = $1`, [t]),
    ];
    const before = await evidence();

    const run_id = randomUUID();
    const res = await http().post('/v1/sign/s2s/talent-erasure/erase').set('Authorization', ATS).send({ tenant_id: t, run_id, record_ids: [rec], document_refs: [doc] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'erased', run_id, counts: { idempotency_keys: 1, api_idempotency_keys: 1, outbox_events: 1 } });

    const naming = (table: string, col: string, tenant_id: string, id: string) =>
      n(`SELECT count(*)::int AS n FROM "sign"."${table}" WHERE tenant_id = $1 AND ${col}::text LIKE '%' || $2 || '%'`, [tenant_id, id]);
    expect([await naming('IdempotencyKey', 'response_body', t, rec), await naming('SignIdempotencyKey', 'response_body', t, rec), await naming('OutboxEvent', 'event_payload', t, rec)]).toEqual([0, 0, 0]);
    // The bystander in this tenant and the same record id in another tenant are untouched.
    expect([await naming('IdempotencyKey', 'response_body', t, bystander), await naming('OutboxEvent', 'event_payload', t, bystander)]).toEqual([1, 1]);
    expect([await naming('IdempotencyKey', 'response_body', elsewhere, rec), await naming('SignIdempotencyKey', 'response_body', elsewhere, rec), await naming('OutboxEvent', 'event_payload', elsewhere, rec)]).toEqual([1, 1, 1]);
    expect(await evidence()).toEqual(before);

    const again = await http().post('/v1/sign/s2s/talent-erasure/erase').set('Authorization', ATS).send({ tenant_id: t, run_id, record_ids: [rec], document_refs: [] });
    expect(again.body.counts).toEqual({ idempotency_keys: 0, api_idempotency_keys: 0, outbox_events: 0 });
  });

  it('erase under a blocker (undelivered event, legal hold) deletes nothing', async () => {
    const t = await tenant();
    const rec = randomUUID();
    await cacheRows(t, rec, 'blocked');
    await db.query(`INSERT INTO "sign"."OutboxEvent" (id, tenant_id, event_type, event_payload) VALUES ($1,$2,'sign.envelope.sent.v1',$3::jsonb)`, [
      randomUUID(),
      t,
      JSON.stringify({ talent_record_id: rec }),
    ]);
    const res = await http().post('/v1/sign/s2s/talent-erasure/erase').set('Authorization', ATS).send({ tenant_id: t, run_id: randomUUID(), record_ids: [rec], document_refs: [] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('blocked');
    expect(res.body.holders.map((h: { classification: string }) => h.classification)).toEqual(['PENDING_OUTBOX_DRAIN']);
    expect(await n(`SELECT count(*)::int AS n FROM "sign"."IdempotencyKey" WHERE tenant_id = $1`, [t])).toBe(1);
    expect(await n(`SELECT count(*)::int AS n FROM "sign"."OutboxEvent" WHERE tenant_id = $1`, [t])).toBe(2);

    const held = await tenant(true);
    await cacheRows(held, rec, 'held');
    const h = await http().post('/v1/sign/s2s/talent-erasure/erase').set('Authorization', ATS).send({ tenant_id: held, run_id: randomUUID(), record_ids: [rec], document_refs: [] });
    expect(h.body.status).toBe('blocked');
    expect(await n(`SELECT count(*)::int AS n FROM "sign"."IdempotencyKey" WHERE tenant_id = $1`, [held])).toBe(1);
  });
});
