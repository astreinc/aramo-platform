import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { PrismaService, SignWebhookRepository } from '@aramo/sign';
import cookieParser from 'cookie-parser';
import { exportSPKI, generateKeyPair } from 'jose';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app/app.module.js';
import { encryptWebhookSecret } from '../app/integrations/webhook-secrets.js';

// Addendum S6 ruling 1 — END-TO-END on real Postgres 17 with the real AppModule:
// the event-bound executed-artifact read grant. The ATS authenticates as its own
// first-party client and presents a completion event Sign delivered to it; Sign
// scopes a five-minute read grant from its own records. Forged events, unrelated
// installations, cross-tenant reads, revoked installations and expired grants are
// refused; retries recover idempotently; a dead delivery can be redriven.

const ROOT = resolve(__dirname, '../../../..');
const migrationsOf = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};
const digest = (raw: string): string => createHash('sha256').update(raw, 'utf8').digest('base64url');
// SX-1 item 3 — the evidence manifest re-digests the stored artifact bytes, so the
// seeded hashes are the real SHA-256 of the seeded bytes ('%PDF-1.4' and 'cert').
const EXECUTED_SHA = createHash('sha256').update(Buffer.from('255044462d312e34', 'hex')).digest('hex');
const CERTIFICATE_SHA = createHash('sha256').update(Buffer.from('63657274', 'hex')).digest('hex');

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const ATS = { id: 'sgc_ats_event', secret: `sgs_${randomUUID()}${randomUUID()}` };
const ACME = { id: 'sgc_acme_event', secret: `sgs_${randomUUID()}${randomUUID()}` };
const GRANT = 'urn:aramo:params:oauth:grant-type:sign-event';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Addendum S6 — event-bound executed-artifact grant (end to end)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let module: TestingModule;
  let app: NestExpressApplication;
  const saved: Record<string, string | undefined> = {};
  const ids: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const grant = (client: { id: string; secret: string } | null, event_id: string) =>
    http().post('/v1/sign/oauth/token').send({ grant_type: GRANT, event_id, ...(client !== null ? { client_id: client.id, client_secret: client.secret } : {}) });

  async function completedEnvelope(tenant: string, installation: string | null, source = 'aramo-ats'): Promise<string> {
    const env = randomUUID();
    const doc = randomUUID();
    await db.query(
      `INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by, completed_at, source_application, installation_id) VALUES ($1,$2,'Right to Represent','COMPLETED','SINGLE_SIGNATURE',$3, now(),$4,$5)`,
      [env, tenant, randomUUID(), source, installation],
    );
    await db.query(
      `INSERT INTO "sign"."EnvelopeDocument" (id, tenant_id, envelope_id, document_ref, document_revision_ref, title, source_sha256, ordinal) VALUES ($1,$2,$3,$4,$5,'RTR',$6,1)`,
      [doc, tenant, env, randomUUID(), randomUUID(), 'a'.repeat(64)],
    );
    await db.query(
      `INSERT INTO "sign"."ExecutedDocument" (id, tenant_id, envelope_id, envelope_document_id, source_sha256, executed_sha256, byte_size, executed_bytes) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,8, decode('255044462d312e34','hex'))`,
      [tenant, env, doc, 'a'.repeat(64), EXECUTED_SHA],
    );
    await db.query(
      `INSERT INTO "sign"."ExecutionCertificate" (id, tenant_id, envelope_id, certificate_sha256, byte_size, certificate_bytes) VALUES (gen_random_uuid(),$1,$2,$3,4, decode('63657274','hex'))`,
      [tenant, env, CERTIFICATE_SHA],
    );
    return env;
  }
  async function delivered(subscription: string, tenant: string, envelope: string, event_type = 'sign.envelope.executed.v1', status = 'DELIVERED'): Promise<string> {
    const event = randomUUID();
    await db.query(
      `INSERT INTO "sign"."SignWebhookDelivery" (id, subscription_id, event_id, tenant_id, envelope_id, event_type, payload, status) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'{}'::jsonb,$6)`,
      [subscription, event, tenant, envelope, event_type, status],
    );
    return event;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const lib of ['sign', 'identity', 'entitlement', 'metering', 'subscription']) {
      for (const m of migrationsOf(lib)) await db.query(readFileSync(m, 'utf8'));
    }
    for (const t of [TENANT_A, TENANT_B]) {
      await db.query(`INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, updated_at) VALUES ($1,$2,$2,'BUSINESS','ACTIVE',true, now())`, [t, `t-${t.slice(0, 8)}`]);
      for (const c of ['core', 'ats', 'sign']) await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source) VALUES ($1, $2::entitlement."Capability", 'PROVISIONING')`, [t, c]);
    }
    for (const k of ['DATABASE_URL', 'MAILER_PROVIDER', 'AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY', 'REDIS_URL', 'SIGN_WEBHOOK_SECRET_KEY']) saved[k] = process.env[k];
    process.env['DATABASE_URL'] = url;
    process.env['MAILER_PROVIDER'] = 'stub';
    process.env['AUTH_AUDIENCE'] = 'aramo-s6-test';
    process.env['AUTH_PUBLIC_KEY'] = await exportSPKI((await generateKeyPair('RS256')).publicKey);
    process.env['SIGN_WEBHOOK_SECRET_KEY'] = randomBytes(32).toString('base64');
    delete process.env['REDIS_URL'];

    ids['ats_app'] = (await db.query(`SELECT id FROM "sign"."SignApplication" WHERE key = 'aramo-ats'`)).rows[0].id;
    ids['acme_app'] = randomUUID();
    await db.query(`INSERT INTO "sign"."SignApplication" (id, key, name, kind, requested_permissions, modes) VALUES ($1,'acme-hr','Acme','THIRD_PARTY', ARRAY['sign:envelope:read'], ARRAY['APPLICATION'])`, [ids['acme_app']]);
    for (const t of [TENANT_A, TENANT_B]) {
      const inst = randomUUID();
      ids[`ats_inst_${t}`] = inst;
      await db.query(`INSERT INTO "sign"."SignInstallation" (id, tenant_id, application_id, granted_permissions, modes, first_party_auto) VALUES ($1,$2,$3, ARRAY['sign:envelope:read'], ARRAY['USER'], true)`, [inst, t, ids['ats_app']]);
    }
    ids['acme_inst'] = randomUUID();
    await db.query(`INSERT INTO "sign"."SignInstallation" (id, tenant_id, application_id, granted_permissions, modes, integration_role) VALUES ($1,$2,$3, ARRAY['sign:envelope:read'], ARRAY['APPLICATION'], 'sign_viewer')`, [ids['acme_inst'], TENANT_A, ids['acme_app']]);
    await db.query(`INSERT INTO "sign"."SignCredential" (id, application_id, installation_id, client_id, secret_hash) VALUES (gen_random_uuid(),$1,NULL,$2,$3)`, [ids['ats_app'], ATS.id, digest(ATS.secret)]);
    await db.query(`INSERT INTO "sign"."SignCredential" (id, application_id, installation_id, client_id, secret_hash) VALUES (gen_random_uuid(),$1,$2,$3,$4)`, [ids['acme_app'], ids['acme_inst'], ACME.id, digest(ACME.secret)]);
    const subs = new SignWebhookRepository(new PrismaService(url));
    ids['ats_sub'] = (await subs.createSubscription({ application_id: ids['ats_app'], installation_id: null, tenant_id: null, target_url: 'http://api:3000/v1/integrations/sign/events', event_types: [], secret_ciphertext: encryptWebhookSecret('whs_ats'), internal: true, created_by: null })).id;
    ids['acme_sub'] = (await subs.createSubscription({ application_id: ids['acme_app'], installation_id: ids['acme_inst'], tenant_id: TENANT_A, target_url: 'https://hooks.acme.test/x', event_types: [], secret_ciphertext: encryptWebhookSecret('whs_acme'), internal: false, created_by: null })).id;

    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    app.use(cookieParser());
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

  it('no-user completion: the authenticated ATS gets a 5-minute grant and reads the signed PDF + certificate + document association', async () => {
    const envA = await completedEnvelope(TENANT_A, ids[`ats_inst_${TENANT_A}`]!);
    const event = await delivered(ids['ats_sub']!, TENANT_A, envA);
    const g = await grant(ATS, event);
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ tenant_id: TENANT_A, envelope_id: envA, scope: 'sign:envelope:read', expires_in: 300, mode: 'APPLICATION' });
    const ex = await http().get(`/v1/sign/api/envelopes/${envA}/executed`).set('Authorization', `Bearer ${g.body.access_token}`);
    expect(ex.status).toBe(200);
    expect(ex.body.documents[0]).toMatchObject({ executed_sha256: EXECUTED_SHA });
    expect(typeof ex.body.documents[0].document_ref).toBe('string');
    expect(ex.body.certificate).toMatchObject({ certificate_sha256: CERTIFICATE_SHA });
    expect((await http().get(`/v1/sign/api/envelopes/${envA}/evidence`).set('Authorization', `Bearer ${g.body.access_token}`)).status).toBe(200);
    // Nothing else: no general read, availability, send.
    expect((await http().get(`/v1/sign/api/envelopes/${envA}`).set('Authorization', `Bearer ${g.body.access_token}`)).status).toBe(403);
    expect((await http().get('/v1/sign/api/availability').set('Authorization', `Bearer ${g.body.access_token}`)).status).toBe(403);
    expect((await http().post(`/v1/sign/api/envelopes/${envA}/void`).set('Authorization', `Bearer ${g.body.access_token}`).send({ reason: 'x' })).status).toBe(403);
    // Retries (webhook redelivery) get fresh grants that both work — idempotent recovery.
    const again = await grant(ATS, event);
    expect(again.status).toBe(200);
    expect((await http().get(`/v1/sign/api/envelopes/${envA}/executed`).set('Authorization', `Bearer ${again.body.access_token}`)).status).toBe(200);
  });

  it('the event id is not a bearer credential: without the client credential it is refused', async () => {
    const envA = await completedEnvelope(TENANT_A, ids[`ats_inst_${TENANT_A}`]!);
    const event = await delivered(ids['ats_sub']!, TENANT_A, envA);
    expect((await grant(null, event)).status).toBe(401);
    expect((await grant({ id: ATS.id, secret: 'sgs_wrong' }, event)).status).toBe(401);
  });

  it('forged event ids and events delivered to another installation are refused', async () => {
    expect((await grant(ATS, randomUUID())).body.error.details.reason).toBe('event_not_available');
    const envA = await completedEnvelope(TENANT_A, ids[`ats_inst_${TENANT_A}`]!);
    const atsEvent = await delivered(ids['ats_sub']!, TENANT_A, envA);
    // An unrelated (third-party) installation presenting the ATS's event.
    const r = await grant(ACME, atsEvent);
    expect(r.status).toBe(403);
    expect(r.body.error.details.reason).toBe('event_not_available');
    // The ATS presenting an event delivered to the third party.
    const acmeEnv = await completedEnvelope(TENANT_A, ids['acme_inst']!, 'acme-hr');
    const acmeEvent = await delivered(ids['acme_sub']!, TENANT_A, acmeEnv);
    expect((await grant(ATS, acmeEvent)).status).toBe(403);
  });

  it('cross-tenant: a grant for tenant B’s event never reads tenant A’s envelope', async () => {
    const envA = await completedEnvelope(TENANT_A, ids[`ats_inst_${TENANT_A}`]!);
    const envB = await completedEnvelope(TENANT_B, ids[`ats_inst_${TENANT_B}`]!);
    const g = await grant(ATS, await delivered(ids['ats_sub']!, TENANT_B, envB));
    expect(g.body.tenant_id).toBe(TENANT_B);
    expect((await http().get(`/v1/sign/api/envelopes/${envA}/executed`).set('Authorization', `Bearer ${g.body.access_token}`)).status).toBe(404);
    expect((await http().get(`/v1/sign/api/envelopes/${envB}/executed`).set('Authorization', `Bearer ${g.body.access_token}`)).status).toBe(200);
  });

  it('expired grants stop working; a new grant recovers', async () => {
    const envA = await completedEnvelope(TENANT_A, ids[`ats_inst_${TENANT_A}`]!);
    const event = await delivered(ids['ats_sub']!, TENANT_A, envA);
    const g = await grant(ATS, event);
    await db.query(`UPDATE "sign"."SignAccessToken" SET expires_at = now() - interval '1 second' WHERE event_id = $1`, [event]);
    const dead = await http().get(`/v1/sign/api/envelopes/${envA}/executed`).set('Authorization', `Bearer ${g.body.access_token}`);
    expect(dead.status).toBe(401);
    expect(dead.body.error.details.reason).toBe('token_expired');
    const fresh = await grant(ATS, event);
    expect((await http().get(`/v1/sign/api/envelopes/${envA}/executed`).set('Authorization', `Bearer ${fresh.body.access_token}`)).status).toBe(200);
  });

  it('interrupted processing: a dead delivery is redriven and its event still grants access', async () => {
    const envA = await completedEnvelope(TENANT_A, ids[`ats_inst_${TENANT_A}`]!);
    const event = await delivered(ids['ats_sub']!, TENANT_A, envA, 'sign.envelope.executed.v1', 'DEAD');
    expect((await grant(ATS, event)).status).toBe(200);
    const redriven = await new SignWebhookRepository(new PrismaService(container.getConnectionUri())).redrive({ subscription_id: ids['ats_sub']! });
    expect(redriven).toBeGreaterThanOrEqual(1);
    expect((await db.query(`SELECT status, attempt_count FROM "sign"."SignWebhookDelivery" WHERE event_id = $1`, [event])).rows[0]).toEqual({ status: 'PENDING', attempt_count: 0 });
  });

  it('revoking the installation immediately ends access, including grants already issued', async () => {
    const envA = await completedEnvelope(TENANT_A, ids[`ats_inst_${TENANT_A}`]!);
    const event = await delivered(ids['ats_sub']!, TENANT_A, envA);
    const g = await grant(ATS, event);
    await db.query(`UPDATE "sign"."SignInstallation" SET status = 'REVOKED', revoked_at = now() WHERE id = $1`, [ids[`ats_inst_${TENANT_A}`]]);
    const r = await http().get(`/v1/sign/api/envelopes/${envA}/executed`).set('Authorization', `Bearer ${g.body.access_token}`);
    expect(r.status).toBe(401);
    expect((await grant(ATS, event)).status).toBe(403);
    await db.query(`UPDATE "sign"."SignInstallation" SET status = 'ACTIVE', revoked_at = NULL WHERE id = $1`, [ids[`ats_inst_${TENANT_A}`]]);
  });
});
