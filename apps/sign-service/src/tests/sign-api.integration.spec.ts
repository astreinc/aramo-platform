import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { DOCUMENT_STORAGE_PORT, type DocumentStoragePort, type PutOwnedSourceInput } from '@aramo/sign';
import { ESIGN_ROLE_PERMISSIONS } from '@aramo/identity';
import cookieParser from 'cookie-parser';
import { SignJWT, exportSPKI, generateKeyPair, type KeyLike } from 'jose';
import { PDFDocument } from 'pdf-lib';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app/app.module.js';

// Sign Unified Product S-4 — END-TO-END on real Postgres 17 with the real
// AppModule, real migrations, real RBAC resolution and real RS256 user tokens:
//   ATS (first-party, USER mode): a recruiter's Aramo access token is exchanged
//   for a short-lived Sign token through the ATS client credential; the
//   installation is established automatically (recorded, revocable); the Sign
//   API creates an envelope with full provenance; isolation and refusals hold;
//   a Sign admin revokes the installation and every token stops working.
//   Third party (APPLICATION mode): a Sign admin installs, issues a credential
//   (secret shown once), maps roles (narrowing only); the integration uploads a
//   PDF and creates an envelope; revoking the credential revokes its tokens.

const ROOT = resolve(__dirname, '../../../..');
const migrationsOf = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};
const digest = (raw: string): string => createHash('sha256').update(raw, 'utf8').digest('base64url');

const AUDIENCE = 'aramo-sign-integration-test';
const TENANT = randomUUID();
const RECRUITER = randomUUID();
const RECRUITER_2 = randomUUID();
const VIEWER = randomUUID();
const ADMIN = randomUUID();
const ATS_CLIENT = { id: 'sgc_ats_integration', secret: `sgs_${randomUUID()}${randomUUID()}` };
const EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS = 'urn:ietf:params:oauth:token-type:access_token';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Sign API — end to end (S-4)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let module: TestingModule;
  let app: NestExpressApplication;
  let key: KeyLike;
  const saved: Record<string, string | undefined> = {};
  const owned = new Map<string, Uint8Array>();
  const storage: DocumentStoragePort = {
    async putOwnedSource(i: PutOwnedSourceInput) {
      const k = `esign/source/${i.tenant_id}/${i.envelope_id}/${randomUUID()}`;
      owned.set(k, new Uint8Array(i.bytes));
      return { source_object_key: k, byte_size: i.bytes.byteLength, source_sha256: createHash('sha256').update(i.bytes).digest('hex') };
    },
    async getOwnedSource(k: string) {
      const b = owned.get(k);
      if (b === undefined) throw new Error('missing');
      return b;
    },
  };

  const jwt = (sub: string, consumer: string): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sub, actor_kind: 'user', consumer_type: consumer, tenant_id: TENANT, authz_version: 1 })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer('Aramo Core Auth')
      .setAudience(AUDIENCE)
      .setSubject(sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(key);
  };

  async function role(roleKey: string, scopes: readonly string[]): Promise<void> {
    await db.query(`INSERT INTO identity."Role" (id, key, description, updated_at) VALUES ($1,$2,$2, now()) ON CONFLICT (key) DO NOTHING`, [randomUUID(), roleKey]);
    for (const s of scopes) {
      await db.query(`INSERT INTO identity."Scope" (id, key) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`, [randomUUID(), s]);
      await db.query(
        `INSERT INTO identity."RoleScope" (id, role_id, scope_id) SELECT gen_random_uuid(), r.id, s.id FROM identity."Role" r, identity."Scope" s WHERE r.key = $1 AND s.key = $2 ON CONFLICT (role_id, scope_id) DO NOTHING`,
        [roleKey, s],
      );
    }
  }
  async function member(userId: string, email: string, roleKey: string): Promise<void> {
    const m = randomUUID();
    await db.query(`INSERT INTO identity."User" (id, email, display_name, tenant_id, updated_at) VALUES ($1,$2,$2,$3, now())`, [userId, email, TENANT]);
    await db.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, updated_at) VALUES ($1,$2,$3, now())`, [m, userId, TENANT]);
    await db.query(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) SELECT gen_random_uuid(), $1, r.id FROM identity."Role" r WHERE r.key = $2`, [m, roleKey]);
    await db.query(`INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at) VALUES (gen_random_uuid(),$1,$2,1, now())`, [TENANT, userId]);
  }

  const http = () => request(app.getHttpServer());
  const exchange = async (userToken: string, client = ATS_CLIENT) =>
    http().post('/v1/sign/oauth/token').send({ grant_type: EXCHANGE, client_id: client.id, client_secret: client.secret, subject_token: userToken, subject_token_type: ACCESS });

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const lib of ['sign', 'identity', 'entitlement', 'metering', 'subscription']) {
      for (const m of migrationsOf(lib)) await db.query(readFileSync(m, 'utf8'));
    }
    await db.query(`INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, updated_at) VALUES ($1,'Integration Co','integration-co','BUSINESS','ACTIVE',true, now())`, [TENANT]);
    for (const c of ['core', 'ats', 'sign']) {
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1, $2::entitlement."Capability")`, [TENANT, c]);
    }
    await db.query(
      `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, product_key, composition_role, period_anchor, source, created_by) SELECT gen_random_uuid(), $1::uuid, p.id, p.product_key, 'BASE', now(), 'MANUAL', 'integration-test' FROM subscription."Plan" p WHERE p.key = 'aramo-sign-included-v1'`,
      [TENANT],
    );
    await role('recruiter', ['document:execute', 'talent:read']);
    await role('viewer', ['talent:read']);
    await role('sign_admin', ESIGN_ROLE_PERMISSIONS.sign_admin);
    await member(RECRUITER, 'rita@integration.test', 'recruiter');
    await member(RECRUITER_2, 'rob@integration.test', 'recruiter');
    await member(VIEWER, 'val@integration.test', 'viewer');
    await member(ADMIN, 'ada@integration.test', 'sign_admin');
    // The operator-provisioned first-party ATS credential (digest only).
    await db.query(
      `INSERT INTO "sign"."SignCredential" (id, application_id, installation_id, client_id, secret_hash) SELECT gen_random_uuid(), a.id, NULL, $1, $2 FROM "sign"."SignApplication" a WHERE a.key = 'aramo-ats'`,
      [ATS_CLIENT.id, digest(ATS_CLIENT.secret)],
    );

    const kp = await generateKeyPair('RS256');
    key = kp.privateKey;
    for (const k of ['DATABASE_URL', 'MAILER_PROVIDER', 'AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY', 'REDIS_URL']) saved[k] = process.env[k];
    process.env['DATABASE_URL'] = url;
    process.env['MAILER_PROVIDER'] = 'stub';
    process.env['AUTH_AUDIENCE'] = AUDIENCE;
    process.env['AUTH_PUBLIC_KEY'] = await exportSPKI(kp.publicKey);
    delete process.env['REDIS_URL'];

    module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DOCUMENT_STORAGE_PORT).useValue(storage).compile();
    app = module.createNestApplication<NestExpressApplication>();
    app.useBodyParser('json', { limit: '36mb' });
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

  let ritaToken = '';
  let envelopeId = '';
  let installationId = '';

  it('ATS: a recruiter’s Aramo token is exchanged for a narrow Sign token; the installation is established automatically', async () => {
    const res = await exchange(await jwt(RECRUITER, 'recruiter'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ token_type: 'Bearer', tenant_id: TENANT, mode: 'USER' });
    expect(res.body.expires_in).toBeLessThanOrEqual(300);
    expect(res.body.scope.split(' ')).not.toContain('sign:member:manage');
    ritaToken = res.body.access_token;
    installationId = res.body.installation_id;
    const inst = await db.query(`SELECT status, first_party_auto, approved_by FROM "sign"."SignInstallation" WHERE id = $1`, [installationId]);
    expect(inst.rows[0]).toMatchObject({ status: 'ACTIVE', first_party_auto: true, approved_by: null });
    const stored = await db.query(`SELECT count(*)::int AS n FROM "sign"."SignAccessToken" WHERE token_hash = $1`, [digest(ritaToken)]);
    expect(stored.rows[0].n).toBe(1);
    const raw = await db.query(`SELECT count(*)::int AS n FROM "sign"."SignAccessToken" WHERE token_hash = $1`, [ritaToken]);
    expect(raw.rows[0].n).toBe(0);
  });

  it('ATS: availability is answered by Sign (D-12)', async () => {
    const res = await http().get('/v1/sign/api/availability').set('Authorization', `Bearer ${ritaToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: true, reason: null, allowance: { limit: 100, used: 0 } });
  });

  it('ATS: creates an envelope by reference with full provenance', async () => {
    const res = await http()
      .post('/v1/sign/api/envelopes')
      .set('Authorization', `Bearer ${ritaToken}`)
      .send({ subject: 'Right to Represent', documents: [{ document_ref: randomUUID(), document_revision_ref: randomUUID(), title: 'RTR', source_sha256: 'a'.repeat(64) }], signers: [{ name: 'Talent', email: 'talent@example.test' }] });
    expect(res.status).toBe(201);
    envelopeId = res.body.envelope_id;
    const row = await db.query(`SELECT created_by, source_application, installation_id, origin_actor_kind, tenant_id FROM "sign"."SignatureEnvelope" WHERE id = $1`, [envelopeId]);
    expect(row.rows[0]).toEqual({ created_by: RECRUITER, source_application: 'aramo-ats', installation_id: installationId, origin_actor_kind: 'USER', tenant_id: TENANT });
  });

  it('ATS: another authorized recruiter may follow it up (ATS workflow) — recorded as that recruiter', async () => {
    const rob = (await exchange(await jwt(RECRUITER_2, 'recruiter'))).body.access_token as string;
    expect((await http().get(`/v1/sign/api/envelopes/${envelopeId}`).set('Authorization', `Bearer ${rob}`)).status).toBe(200);
    const v = await http().post(`/v1/sign/api/envelopes/${envelopeId}/void`).set('Authorization', `Bearer ${rob}`).send({ reason: 'Wrong talent' });
    expect(v.status).toBe(200);
    const ev = await db.query(`SELECT actor_ref FROM "sign"."SignatureEvent" WHERE envelope_id = $1 AND event_type LIKE '%VOID%'`, [envelopeId]);
    expect(ev.rows.map((r) => r.actor_ref)).toContain(RECRUITER_2);
  });

  it('ATS: a user without the ATS signature permission gets no Sign authority', async () => {
    const res = await exchange(await jwt(VIEWER, 'recruiter'));
    expect(res.status).toBe(403);
    expect(res.body.error.details.reason).toBe('no_authority');
  });

  it('isolation: an envelope created in the Sign app is invisible to the ATS integration', async () => {
    const own = randomUUID();
    await db.query(`INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by) VALUES ($1,$2,'Sign-app NDA','DRAFT','SINGLE_SIGNATURE',$3)`, [own, TENANT, RECRUITER]);
    expect((await http().get(`/v1/sign/api/envelopes/${own}`).set('Authorization', `Bearer ${ritaToken}`)).status).toBe(404);
  });

  it('a session JWT, a wrong secret or no token never reaches the Sign API', async () => {
    const session = await jwt(ADMIN, 'sign');
    expect((await http().get('/v1/sign/api/availability').set('Authorization', `Bearer ${session}`)).status).toBe(401);
    expect((await http().get('/v1/sign/api/availability')).status).toBe(401);
    const bad = await exchange(await jwt(RECRUITER, 'recruiter'), { id: ATS_CLIENT.id, secret: 'sgs_wrong' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.details.reason).toBe('invalid_client');
  });

  it('a Sign admin sees the automatic installation, revokes it, and every token stops working', async () => {
    const adminJwt = await jwt(ADMIN, 'sign');
    const list = await http().get('/v1/sign/sender/integrations').set('Authorization', `Bearer ${adminJwt}`);
    expect(list.status).toBe(200);
    expect(list.body.installations.find((i: { id: string }) => i.id === installationId)).toMatchObject({ established: 'AUTOMATIC', status: 'ACTIVE' });
    const r = await http().post(`/v1/sign/sender/integrations/installations/${installationId}/revoke`).set('Authorization', `Bearer ${adminJwt}`);
    expect(r.status).toBe(200);
    const after = await http().get('/v1/sign/api/availability').set('Authorization', `Bearer ${ritaToken}`);
    expect(after.status).toBe(401);
    const again = await exchange(await jwt(RECRUITER, 'recruiter'));
    expect(again.status).toBe(403);
    expect(again.body.error.details.reason).toBe('installation_revoked');
  });

  it('third party: install → credential (secret once) → narrowed role mapping → upload-and-create → credential revocation', async () => {
    await db.query(
      `INSERT INTO "sign"."SignApplication" (id, key, name, kind, requested_permissions, modes, assertable_roles) VALUES ($1,'acme-hr','Acme HR','THIRD_PARTY', ARRAY['sign:envelope:read','sign:envelope:create','sign:envelope:send'], ARRAY['APPLICATION'], ARRAY['hr_manager','hr_clerk'])`,
      [randomUUID()],
    );
    const adminJwt = await jwt(ADMIN, 'sign');
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${adminJwt}`);
    const inst = await auth(http().post('/v1/sign/sender/integrations/installations')).send({
      application_key: 'acme-hr',
      granted_permissions: ['sign:envelope:read', 'sign:envelope:create', 'sign:envelope:send'],
      modes: ['APPLICATION'],
      integration_role: 'sign_sender',
      role_assertion_enabled: true,
    });
    expect(inst.status).toBe(201);
    const cred = await auth(http().post(`/v1/sign/sender/integrations/installations/${inst.body.id}/credentials`));
    expect(cred.status).toBe(201);
    expect(cred.body.client_secret).toMatch(/^sgs_/);
    const listed = await auth(http().get('/v1/sign/sender/integrations'));
    expect(JSON.stringify(listed.body)).not.toContain(cred.body.client_secret);
    const cc = (extra: Record<string, unknown> = {}) =>
      http().post('/v1/sign/oauth/token').send({ grant_type: 'client_credentials', client_id: cred.body.client_id, client_secret: cred.body.client_secret, ...extra });

    const unmapped = await cc({ external_role: 'hr_clerk' });
    expect(unmapped.status).toBe(403);
    expect(unmapped.body.error.details.reason).toBe('role_unmapped');
    expect((await auth(http().put(`/v1/sign/sender/integrations/installations/${inst.body.id}/role-mappings`)).send({ mappings: [{ external_role: 'hr_clerk', sign_role: 'sign_viewer' }] })).status).toBe(200);
    const narrowed = await cc({ external_role: 'hr_clerk', external_actor: 'jane@acme.test' });
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.scope).toBe('sign:envelope:read');

    const full = (await cc({ external_actor: 'hr-sync' })).body.access_token as string;
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    const b64 = Buffer.from(await pdf.save()).toString('base64');
    const refused = await http().post('/v1/sign/api/envelopes').set('Authorization', `Bearer ${full}`).send({ subject: 'Offer', documents: [{ document_ref: randomUUID(), document_revision_ref: randomUUID(), source_sha256: 'x' }], signers: [{ name: 'A', email: 'a@x.test' }] });
    expect(refused.status).toBe(400);
    const created = await http()
      .post('/v1/sign/api/envelopes')
      .set('Authorization', `Bearer ${full}`)
      .send({ subject: 'Offer letter', documents: [{ title: 'Offer', content_base64: b64 }], signers: [{ name: 'Sam', email: 'sam@acme.test' }], fields: [{ document_ordinal: 0, signer_signing_order: 1, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 72, width: 200, height: 40 }] });
    expect(created.status).toBe(201);
    const row = await db.query(`SELECT created_by, source_application, installation_id, origin_actor_kind FROM "sign"."SignatureEnvelope" WHERE id = $1`, [created.body.envelope_id]);
    expect(row.rows[0]).toEqual({ created_by: inst.body.id, source_application: 'acme-hr', installation_id: inst.body.id, origin_actor_kind: 'APPLICATION' });

    const credId = (await auth(http().get('/v1/sign/sender/integrations'))).body.installations.find((i: { id: string }) => i.id === inst.body.id).credentials[0].id;
    expect((await auth(http().post(`/v1/sign/sender/integrations/installations/${inst.body.id}/credentials/${credId}/revoke`))).status).toBe(200);
    const dead = await http().get(`/v1/sign/api/envelopes/${created.body.envelope_id}`).set('Authorization', `Bearer ${full}`);
    expect(dead.status).toBe(401);
    expect((await cc()).status).toBe(401);
  });
});
