import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { hashSigningToken } from '@aramo/sign';
import cookieParser from 'cookie-parser';
import { SignJWT, exportSPKI, generateKeyPair, type KeyLike } from 'jose';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app/app.module.js';

// Sign Unified Product S-7 — END-TO-END: a user of tenant B receives a document
// from tenant A. Binding needs the live signing link AND the user's own email;
// the binding gives recipient-only access (no tenant A data beyond its name, no
// sender surfaces); the inbox issues a fresh signing link while the emailed one
// stays valid; void ends signing; the user can remove the binding.

const ROOT = resolve(__dirname, '../../../..');
const migrationsOf = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};

const AUDIENCE = 'aramo-sign-inbox-test';
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const BOB = randomUUID();
const CAROL = randomUUID();
const SENDER = randomUUID();
const ENVELOPE = randomUUID();
const SIGNER = randomUUID();
const EMAIL_TOKEN = `emailtok_${randomUUID().replace(/-/g, '')}`;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Recipient inbox — end to end (S-7)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let module: TestingModule;
  let app: NestExpressApplication;
  let key: KeyLike;
  const saved: Record<string, string | undefined> = {};

  const jwt = (sub: string, tenant: string): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sub, actor_kind: 'user', consumer_type: 'sign', tenant_id: tenant, authz_version: 1 })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer('Aramo Core Auth')
      .setAudience(AUDIENCE)
      .setSubject(sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(key);
  };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const lib of ['sign', 'identity', 'entitlement', 'metering', 'subscription']) {
      for (const m of migrationsOf(lib)) await db.query(readFileSync(m, 'utf8'));
    }
    for (const [id, name] of [[TENANT_A, 'Northwind Staffing'], [TENANT_B, 'Bob Personal']] as const) {
      await db.query(`INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, updated_at) VALUES ($1,$2,$3,'BUSINESS','ACTIVE',true, now())`, [id, name, `t-${id.slice(0, 8)}`]);
      for (const c of ['core', 'sign']) await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1, $2::entitlement."Capability")`, [id, c]);
    }
    for (const [id, email, tenant] of [[BOB, 'Bob@Example.test', TENANT_B], [CAROL, 'carol@example.test', TENANT_B], [SENDER, 'sam@northwind.test', TENANT_A]] as const) {
      const m = randomUUID();
      await db.query(`INSERT INTO identity."User" (id, email, display_name, tenant_id, updated_at) VALUES ($1,$2,$2,$3, now())`, [id, email, tenant]);
      await db.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, updated_at) VALUES ($1,$2,$3, now())`, [m, id, tenant]);
      await db.query(`INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at) VALUES (gen_random_uuid(),$1,$2,1, now())`, [tenant, id]);
    }
    // Tenant A sent an envelope to bob@example.test; the emailed link's session.
    await db.query(
      `INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by, sent_at, expires_at) VALUES ($1,$2,'Offer letter','SENT','SINGLE_SIGNATURE',$3, now(), now() + interval '30 days')`,
      [ENVELOPE, TENANT_A, SENDER],
    );
    await db.query(`INSERT INTO "sign"."Signer" (id, tenant_id, envelope_id, email, name, signing_order, status) VALUES ($1,$2,$3,'bob@example.test','Bob',1,'PENDING')`, [SIGNER, TENANT_A, ENVELOPE]);
    await db.query(
      `INSERT INTO "sign"."SigningSession" (id, tenant_id, envelope_id, signer_id, token_hash, status, expires_at) VALUES (gen_random_uuid(),$1,$2,$3,$4,'ISSUED', now() + interval '7 days')`,
      [TENANT_A, ENVELOPE, SIGNER, hashSigningToken(EMAIL_TOKEN)],
    );

    const kp = await generateKeyPair('RS256');
    key = kp.privateKey;
    for (const k of ['DATABASE_URL', 'MAILER_PROVIDER', 'AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY', 'REDIS_URL', 'ARAMO_SIGN_BASE_URL']) saved[k] = process.env[k];
    process.env['DATABASE_URL'] = url;
    process.env['MAILER_PROVIDER'] = 'stub';
    process.env['AUTH_AUDIENCE'] = AUDIENCE;
    process.env['AUTH_PUBLIC_KEY'] = await exportSPKI(kp.publicKey);
    process.env['ARAMO_SIGN_BASE_URL'] = 'https://sign.example.test';
    delete process.env['REDIS_URL'];
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

  let bindingId = '';

  it('another user of the same organization cannot claim Bob’s document, even holding the link', async () => {
    const res = await http().post('/v1/sign/inbox/claim').set('Authorization', `Bearer ${await jwt(CAROL, TENANT_B)}`).send({ token: EMAIL_TOKEN });
    expect(res.status).toBe(403);
    expect(res.body.error.details.reason).toBe('recipient_mismatch');
  });

  it('Bob claims it with his own link and verified email; his inbox shows only recipient facts', async () => {
    const bob = await jwt(BOB, TENANT_B);
    const claim = await http().post('/v1/sign/inbox/claim').set('Authorization', `Bearer ${bob}`).send({ token: EMAIL_TOKEN });
    expect(claim.status).toBe(201);
    bindingId = claim.body.id;
    const list = await http().get('/v1/sign/inbox').set('Authorization', `Bearer ${bob}`);
    expect(list.status).toBe(200);
    expect(list.body.waiting).toHaveLength(1);
    expect(list.body.waiting[0]).toMatchObject({ subject: 'Offer letter', from: 'Northwind Staffing', can_sign: true });
    const text = JSON.stringify(list.body);
    for (const internal of [TENANT_A, ENVELOPE, SIGNER, SENDER]) expect(text).not.toContain(internal);
    const row = (await db.query(`SELECT envelope_tenant_id, user_tenant_id FROM "sign"."SignRecipientBinding" WHERE id = $1`, [bindingId])).rows[0];
    expect(row).toEqual({ envelope_tenant_id: TENANT_A, user_tenant_id: TENANT_B });
  });

  it('the binding grants no membership: Bob cannot reach tenant A through any sender surface', async () => {
    const bob = await jwt(BOB, TENANT_B);
    expect((await http().get(`/v1/sign/sender/envelopes/${ENVELOPE}`).set('Authorization', `Bearer ${bob}`)).status).toBeGreaterThanOrEqual(403);
    expect((await http().get('/v1/sign/sender/envelopes').set('Authorization', `Bearer ${bob}`)).status).toBe(403);
    const m = await db.query(`SELECT count(*)::int AS n FROM identity."UserTenantMembership" WHERE user_id = $1 AND tenant_id = $2`, [BOB, TENANT_A]);
    expect(m.rows[0].n).toBe(0);
  });

  it('Carol cannot use Bob’s binding', async () => {
    expect((await http().post(`/v1/sign/inbox/${bindingId}/sign`).set('Authorization', `Bearer ${await jwt(CAROL, TENANT_B)}`)).status).toBe(404);
  });

  it('signing from the inbox issues a fresh link and the emailed link stays valid', async () => {
    const res = await http().post(`/v1/sign/inbox/${bindingId}/sign`).set('Authorization', `Bearer ${await jwt(BOB, TENANT_B)}`);
    expect(res.status).toBe(200);
    expect(res.body.signing_url).toMatch(/^https:\/\/sign\.example\.test\/s\//);
    const sessions = (await db.query(`SELECT status FROM "sign"."SigningSession" WHERE signer_id = $1 ORDER BY created_at`, [SIGNER])).rows.map((r) => r.status);
    expect(sessions).toEqual(['ISSUED', 'ISSUED']);
    const ex = await http().post('/v1/sign/signing/exchange').send({ token: EMAIL_TOKEN });
    expect(ex.status).toBe(200);
  });

  it('once voided, the inbox no longer offers signing', async () => {
    await db.query(`UPDATE "sign"."SignatureEnvelope" SET status = 'VOIDED', voided_at = now() WHERE id = $1`, [ENVELOPE]);
    const bob = await jwt(BOB, TENANT_B);
    expect((await http().post(`/v1/sign/inbox/${bindingId}/sign`).set('Authorization', `Bearer ${bob}`)).status).toBe(409);
    expect((await http().get('/v1/sign/inbox').set('Authorization', `Bearer ${bob}`)).body.other).toHaveLength(1);
  });

  it('Bob removes it from his inbox', async () => {
    const bob = await jwt(BOB, TENANT_B);
    expect((await http().delete(`/v1/sign/inbox/${bindingId}`).set('Authorization', `Bearer ${bob}`)).status).toBe(200);
    const list = await http().get('/v1/sign/inbox').set('Authorization', `Bearer ${bob}`);
    expect([...list.body.waiting, ...list.body.completed, ...list.body.other]).toHaveLength(0);
  });
});
