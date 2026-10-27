import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { DOCUMENT_STORAGE_PORT, type DocumentStoragePort, type PutOwnedSourceInput, hashSigningToken } from '@aramo/sign';
import { ESIGN_ROLE_PERMISSIONS } from '@aramo/identity';
import cookieParser from 'cookie-parser';
import { SignJWT, exportSPKI, generateKeyPair, type KeyLike } from 'jose';
import { PDFDocument } from 'pdf-lib';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app/app.module.js';

// Aramo Sign Mobile — the envelope contracts END TO END over HTTP (real AppModule,
// real migrations, real RBAC, RS256 browser and native tokens):
//   M-A3 §6  ETag on detail; If-Match required for native tokens (428), enforced
//            when sent (412 + current_revision); browser clients without it still work;
//   M-A3 §3  the sender message;
//   M-A3 §7  429 reminder_cooldown with retry_after; Idempotency-Key replay / reuse;
//   M-A3 §8  upload idempotency (one document for a retried upload);
//   M-A3 §4/§5/§9  saved signatures and contacts — cross-user and cross-tenant negatives;
//   M-A2 §2.2  inbox signing returns its bounded expiry.

const ROOT = resolve(__dirname, '../../../..');
const migrationsOf = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};

const AUDIENCE = 'aramo-sign-mobile-contracts-test';
const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();
const ANN = randomUUID();
const BEN = randomUUID();
const OLA = randomUUID(); // a sender in OTHER_TENANT
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Sign Mobile envelope contracts — HTTP end to end', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let module: TestingModule;
  let app: NestExpressApplication;
  let key: KeyLike;
  let pdfBase64 = '';
  const saved: Record<string, string | undefined> = {};
  const owned = new Map<string, Uint8Array>();
  const storage: DocumentStoragePort = {
    async putOwnedSource(i: PutOwnedSourceInput) {
      const k = `esign/source/${i.tenant_id}/${i.envelope_id}/${i.object_id ?? randomUUID()}`;
      owned.set(k, new Uint8Array(i.bytes));
      return { source_object_key: k, byte_size: i.bytes.byteLength, source_sha256: createHash('sha256').update(i.bytes).digest('hex') };
    },
    async getOwnedSource(k: string) {
      const b = owned.get(k);
      if (b === undefined) throw new Error('missing');
      return b;
    },
  };

  const jwt = (sub: string, tenant: string, native = false): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sub, actor_kind: 'user', consumer_type: 'sign', tenant_id: tenant, authz_version: 1, ...(native ? { client: 'native', dsid: randomUUID() } : {}) })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer('Aramo Core Auth')
      .setAudience(AUDIENCE)
      .setSubject(sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(key);
  };
  const http = () => request(app.getHttpServer());
  const H = async (sub: string, tenant = TENANT, native = false) => ({ Authorization: `Bearer ${await jwt(sub, tenant, native)}`, 'X-Aramo-Consumer': 'sign' });

  async function member(userId: string, email: string, tenant: string): Promise<void> {
    const m = randomUUID();
    await db.query(`INSERT INTO identity."User" (id, email, display_name, tenant_id, updated_at) VALUES ($1,$2,$2,$3, now())`, [userId, email, tenant]);
    await db.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, updated_at) VALUES ($1,$2,$3, now())`, [m, userId, tenant]);
    await db.query(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) SELECT gen_random_uuid(), $1, r.id FROM identity."Role" r WHERE r.key = 'sign_sender'`, [m]);
    await db.query(`INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at) VALUES (gen_random_uuid(),$1,$2,1, now())`, [tenant, userId]);
  }

  // A SENT envelope of ANN with one signer and a live emailed link.
  async function sentEnvelope(signerEmail = `bob.${randomUUID().slice(0, 8)}@x.test`) {
    const id = randomUUID();
    const signer = randomUUID();
    const token = `tok_${randomUUID().replace(/-/g, '')}`;
    await db.query(`INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by, sent_at, expires_at) VALUES ($1,$2,'Offer','SENT','SINGLE_SIGNATURE',$3, now(), now() + interval '30 days')`, [id, TENANT, ANN]);
    await db.query(`INSERT INTO "sign"."Signer" (id, tenant_id, envelope_id, email, name, signing_order, status) VALUES ($1,$2,$3,$4,'Bob',1,'PENDING')`, [signer, TENANT, id, signerEmail]);
    await db.query(`INSERT INTO "sign"."SigningSession" (id, tenant_id, envelope_id, signer_id, token_hash, status, expires_at) VALUES (gen_random_uuid(),$1,$2,$3,$4,'ISSUED', now() + interval '7 days')`, [TENANT, id, signer, hashSigningToken(token)]);
    return { id, signer, token };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const lib of ['sign', 'identity', 'entitlement', 'metering', 'subscription']) {
      for (const m of migrationsOf(lib)) await db.query(readFileSync(m, 'utf8'));
    }
    for (const [id, slug] of [[TENANT, 'mobile-co'], [OTHER_TENANT, 'other-co']] as const) {
      await db.query(`INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, updated_at) VALUES ($1,$2,$2,'BUSINESS','ACTIVE',true, now())`, [id, slug]);
      for (const c of ['core', 'sign']) await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source) VALUES ($1, $2::entitlement."Capability", 'PROVISIONING')`, [id, c]);
      // The Aramo Sign included plan — uploads reserve storage against it.
      await db.query(
        `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by) SELECT gen_random_uuid(), $1::uuid, p.id, (SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = p.id AND v.status = 'PUBLISHED'), p.product_key, 'BASE', now(), 'MANUAL', 'integration-test' FROM subscription."Plan" p WHERE p.key = 'aramo-sign-included-v1'`,
        [id],
      );
    }
    await db.query(`INSERT INTO identity."Role" (id, key, description, updated_at) VALUES ($1,'sign_sender','sign_sender', now()) ON CONFLICT (key) DO NOTHING`, [randomUUID()]);
    for (const s of ESIGN_ROLE_PERMISSIONS.sign_sender) {
      await db.query(`INSERT INTO identity."Scope" (id, key) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`, [randomUUID(), s]);
      await db.query(
        `INSERT INTO identity."RoleScope" (id, role_id, scope_id) SELECT gen_random_uuid(), r.id, s.id FROM identity."Role" r, identity."Scope" s WHERE r.key = 'sign_sender' AND s.key = $1 ON CONFLICT (role_id, scope_id) DO NOTHING`,
        [s],
      );
    }
    await member(ANN, 'ann@mobile.test', TENANT);
    await member(BEN, 'ben@mobile.test', TENANT);
    await member(OLA, 'ola@other.test', OTHER_TENANT);
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    pdfBase64 = Buffer.from(await pdf.save()).toString('base64');

    const kp = await generateKeyPair('RS256');
    key = kp.privateKey;
    for (const k of ['DATABASE_URL', 'MAILER_PROVIDER', 'AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY', 'REDIS_URL', 'ARAMO_SIGN_BASE_URL']) saved[k] = process.env[k];
    process.env['DATABASE_URL'] = url;
    process.env['MAILER_PROVIDER'] = 'stub';
    process.env['AUTH_AUDIENCE'] = AUDIENCE;
    process.env['AUTH_PUBLIC_KEY'] = await exportSPKI(kp.publicKey);
    process.env['ARAMO_SIGN_BASE_URL'] = 'https://sign.example.test';
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

  describe('M-A3 §6 — ETag and If-Match', () => {
    let envelopeId = '';
    it('detail carries ETag "{id}.{revision}" and the new fields', async () => {
      const created = await http().post('/v1/sign/sender/envelopes').set(await H(ANN)).send({ subject: 'Mobile draft' });
      expect(created.status).toBe(201);
      envelopeId = created.body.id;
      const d = await http().get(`/v1/sign/sender/envelopes/${envelopeId}`).set(await H(ANN));
      expect(d.status).toBe(200);
      expect(d.body).toMatchObject({ revision: 1, message: null, signing_link_valid_days: 7, envelope_expires_at: null, expires_at: null });
      expect(d.headers['etag']).toBe(`"${envelopeId}.1"`);
    });

    it('a native token without If-Match is 428; with the current ETag it writes and returns the next one', async () => {
      const native = await H(ANN, TENANT, true);
      const missing = await http().patch(`/v1/sign/sender/envelopes/${envelopeId}`).set(native).send({ message: 'Hello' });
      expect(missing.status).toBe(428);
      expect(missing.body.error.details.reason).toBe('precondition_required');
      const ok = await http().patch(`/v1/sign/sender/envelopes/${envelopeId}`).set({ ...native, 'If-Match': `"${envelopeId}.1"` }).send({ message: '  Please sign\u0007 by Friday ' });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ revision: 2, message: 'Please sign by Friday' });
      expect(ok.headers['etag']).toBe(`"${envelopeId}.2"`);
    });

    it('a stale If-Match is 412 with the current revision — for native and browser tokens alike', async () => {
      for (const native of [true, false]) {
        const res = await http().patch(`/v1/sign/sender/envelopes/${envelopeId}`).set({ ...(await H(ANN, TENANT, native)), 'If-Match': `"${envelopeId}.1"` }).send({ subject: 'X' });
        expect(res.status).toBe(412);
        expect(res.body.error.details).toEqual({ reason: 'revision_mismatch', current_revision: 2 });
      }
    });

    it('a browser client without If-Match still works (web compatibility)', async () => {
      const res = await http().patch(`/v1/sign/sender/envelopes/${envelopeId}`).set(await H(ANN)).send({ subject: 'Renamed from the web' });
      expect(res.status).toBe(200);
      expect(res.body.revision).toBe(3);
    });

    it('native upload / void need If-Match as well; a retried upload with one Idempotency-Key creates one document', async () => {
      const native = await H(ANN, TENANT, true);
      expect((await http().post(`/v1/sign/sender/envelopes/${envelopeId}/documents`).set(native).send({ filename: 'a.pdf', content_base64: pdfBase64 })).status).toBe(428);
      const key = `upload-${randomUUID()}`;
      const first = await http().post(`/v1/sign/sender/envelopes/${envelopeId}/documents`).set({ ...native, 'If-Match': `"${envelopeId}.3"`, 'Idempotency-Key': key }).send({ filename: 'a.pdf', content_base64: pdfBase64 });
      expect(first.status).toBe(201);
      // The retry (same key, same body) returns the first result instead of attaching a second document.
      const retry = await http().post(`/v1/sign/sender/envelopes/${envelopeId}/documents`).set({ ...native, 'If-Match': `"${envelopeId}.4"`, 'Idempotency-Key': key }).send({ filename: 'a.pdf', content_base64: pdfBase64 });
      expect(retry.status).toBe(201);
      expect(retry.body.id).toBe(first.body.id);
      const docs = (await db.query(`SELECT count(*)::int n FROM "sign"."EnvelopeDocument" WHERE envelope_id = $1`, [envelopeId])).rows[0].n;
      expect(docs).toBe(1);
      const reuse = await http().post(`/v1/sign/sender/envelopes/${envelopeId}/documents`).set({ ...native, 'If-Match': `"${envelopeId}.4"`, 'Idempotency-Key': key }).send({ filename: 'b.pdf', content_base64: pdfBase64 });
      expect(reuse.status).toBe(422);
      expect(reuse.body.error.details.reason).toBe('idempotency_key_reuse');
      const word = await http().post(`/v1/sign/sender/envelopes/${envelopeId}/documents`).set({ ...native, 'If-Match': `"${envelopeId}.4"` }).send({ filename: 'offer.docx', content_base64: 'UEsDBAoAAAAAAA==' });
      expect(word.status).toBe(400);
      expect(word.body.error.details.reason).toBe('unsupported_file_type');
      expect((await http().post(`/v1/sign/sender/envelopes/${envelopeId}/void`).set(native).send({ reason: 'x' })).status).toBe(428);
    });
  });

  describe('M-A3 §7 — reminder limits and idempotency over HTTP', () => {
    it('429 reminder_cooldown with retry_after; a replayed Idempotency-Key returns the first response and does not count', async () => {
      const e = await sentEnvelope();
      const key = `remind-${randomUUID()}`;
      const first = await http().post(`/v1/sign/sender/envelopes/${e.id}/remind`).set({ ...(await H(ANN)), 'Idempotency-Key': key }).send({ signer_id: e.signer });
      expect(first.status).toBe(200);
      const replay = await http().post(`/v1/sign/sender/envelopes/${e.id}/remind`).set({ ...(await H(ANN)), 'Idempotency-Key': key }).send({ signer_id: e.signer });
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(first.body);
      const events = (await db.query(`SELECT count(*)::int n FROM "sign"."SignatureEvent" WHERE envelope_id = $1 AND event_type = 'SIGNATURE_REMINDER_SENT'`, [e.id])).rows[0].n;
      expect(events).toBe(1);
      const reuse = await http().post(`/v1/sign/sender/envelopes/${e.id}/remind`).set({ ...(await H(ANN)), 'Idempotency-Key': key }).send({});
      expect(reuse.status).toBe(422);
      const again = await http().post(`/v1/sign/sender/envelopes/${e.id}/remind`).set(await H(ANN)).send({ signer_id: e.signer });
      expect(again.status).toBe(429);
      expect(again.body.error.details.reason).toBe('reminder_cooldown');
      expect(again.body.error.details.retry_after_seconds).toBeGreaterThan(3500);
      expect(again.body.error.details.retry_after_seconds).toBeLessThanOrEqual(3600);
      expect(Date.parse(again.body.error.details.retry_at)).toBeGreaterThan(Date.now());
      // The detail tells the client when.
      const d = await http().get(`/v1/sign/sender/envelopes/${e.id}`).set(await H(ANN));
      expect(d.body.recipients[0].reminder_available_at).toBe(again.body.error.details.retry_at);
    });
  });

  describe('M-A3 §5 — contacts are private per (tenant, owner)', () => {
    it('another user of the same tenant, or another tenant, neither sees nor changes them', async () => {
      const created = await http().post('/v1/sign/sender/contacts').set(await H(ANN)).send({ name: 'Priya', email: 'priya@client.test', organization: 'Client Co' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ name: 'Priya', email: 'priya@client.test', organization: 'Client Co', source: 'saved' });
      const id = created.body.id as string;
      expect((await http().post('/v1/sign/sender/contacts').set(await H(ANN)).send({ name: 'P2', email: 'PRIYA@client.test' })).body.error.details.reason).toBe('contact_exists');
      const mine = await http().get('/v1/sign/sender/contacts').set(await H(ANN));
      expect(mine.body.items).toContainEqual(expect.objectContaining({ id, source: 'saved' }));
      for (const [who, tenant] of [[BEN, TENANT], [OLA, OTHER_TENANT]] as const) {
        const list = await http().get('/v1/sign/sender/contacts').set(await H(who, tenant));
        expect(list.status).toBe(200);
        expect(JSON.stringify(list.body)).not.toContain('priya@client.test');
        expect((await http().patch(`/v1/sign/sender/contacts/${id}`).set(await H(who, tenant)).send({ name: 'Hijack' })).status).toBe(404);
        expect((await http().delete(`/v1/sign/sender/contacts/${id}`).set(await H(who, tenant))).status).toBe(404);
      }
      expect((await http().patch(`/v1/sign/sender/contacts/${id}`).set(await H(ANN)).send({ organization: null })).body.organization).toBeNull();
      expect((await http().delete(`/v1/sign/sender/contacts/${id}`).set(await H(ANN))).status).toBe(204);
    });
  });

  describe('M-A3 §4 — saved signatures are private per (tenant, user)', () => {
    it('put, read, delete; another user or tenant never sees or deletes them; SVG is refused', async () => {
      const put = await http().put('/v1/sign/me/signature').set(await H(ANN)).send({ kind: 'DRAWN', image_data_url: PNG });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({ kind: 'DRAWN', image_data_url: PNG });
      expect((await http().put('/v1/sign/me/initials').set(await H(ANN)).send({ kind: 'TYPED', typed_name: 'AN', font_key: 'caveat', image_data_url: PNG })).status).toBe(200);
      expect((await http().put('/v1/sign/me/signature').set(await H(ANN)).send({ kind: 'DRAWN', image_data_url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })).body.error.details.reason).toBe('invalid_image');
      const own = await http().get('/v1/sign/me/signature').set(await H(ANN));
      expect(own.body.signature).toMatchObject({ kind: 'DRAWN' });
      expect(own.body.initials).toMatchObject({ kind: 'TYPED', typed_name: 'AN' });
      // Another user (same tenant), another tenant's user, and the SAME user under another tenant: keyed by both.
      for (const [who, tenant] of [[BEN, TENANT], [OLA, OTHER_TENANT], [ANN, OTHER_TENANT]] as const) {
        const other = await http().get('/v1/sign/me/signature').set(await H(who, tenant));
        expect(other.status).toBe(200);
        expect(other.body).toEqual({ signature: null, initials: null });
        expect((await http().delete('/v1/sign/me/signature').set(await H(who, tenant))).status).toBe(204);
      }
      expect((await http().get('/v1/sign/me/signature').set(await H(ANN))).body.signature).not.toBeNull();
      expect((await http().delete('/v1/sign/me/signature').set(await H(ANN))).status).toBe(204);
      expect((await http().get('/v1/sign/me/signature').set(await H(ANN))).body.signature).toBeNull();
    });
  });

  describe('M-A2 §2.2 — inbox signing over HTTP', () => {
    it('returns a bounded expiry; after a reminder replaces the claimed link it is 409 session_revoked', async () => {
      const e = await sentEnvelope('ben@mobile.test');
      const claim = await http().post('/v1/sign/inbox/claim').set(await H(BEN)).send({ token: e.token });
      expect(claim.status).toBe(201);
      const sign = await http().post(`/v1/sign/inbox/${claim.body.id}/sign`).set(await H(BEN));
      expect(sign.status).toBe(200);
      expect(Date.parse(sign.body.expires_at) - Date.now()).toBeLessThanOrEqual(30 * 60 * 1000 + 1000);
      expect((await http().post(`/v1/sign/inbox/${claim.body.id}/sign`).set(await H(ANN))).status).toBe(404);
      expect((await http().post(`/v1/sign/sender/envelopes/${e.id}/remind`).set(await H(ANN)).send({})).status).toBe(200);
      const after = await http().post(`/v1/sign/inbox/${claim.body.id}/sign`).set(await H(BEN));
      expect(after.status).toBe(409);
      expect(after.body.error.details.reason).toBe('session_revoked');
    });
  });
  // Aramo-Sign-Unified-Product-Amendment-M-A5 §1–§5, §7 over HTTP: recipient kinds on
  // PUT recipients, readiness, the ON_SEND copy route (source only), hosted and
  // self-sign sessions, inbox-claim refusal of HOSTED / SELF tokens, cross-tenant refusal.
  describe('M-A5 — recipient kinds, copies, hosted and self-signing', () => {
    let envelopeId = '';
    let annSigner = '';
    let ccSigner = '';
    let inPerson = '';
    let documentId = '';
    let hostedToken = '';
    let selfToken = '';
    const CC_EMAIL = `casey.${randomUUID().slice(0, 8)}@client.test`;

    it('PUT recipients takes kinds, copy timing and Assign to me (verified email only); readiness excludes the copy', async () => {
      const created = await http().post('/v1/sign/sender/envelopes').set(await H(ANN)).send({ subject: 'Kinds over HTTP' });
      envelopeId = created.body.id;
      const up = await http().post(`/v1/sign/sender/envelopes/${envelopeId}/documents`).set(await H(ANN)).send({ filename: 'k.pdf', content_base64: pdfBase64 });
      expect(up.status).toBe(201);
      documentId = up.body.id;
      const put = (recipients: unknown[]) => http().put(`/v1/sign/sender/envelopes/${envelopeId}/recipients`).set(H2).send({ recipients });
      const H2 = await H(ANN);
      // Assign to me only with the caller's own verified email; copy timing required for a copy.
      const mismatch = await put([{ name: 'Not Ann', email: 'someone@x.test', assign_to_me: true }]);
      expect(mismatch.status).toBe(403);
      expect(mismatch.body.error.details.reason).toBe('assign_to_me_email_mismatch');
      expect((await put([{ name: 'Casey', email: CC_EMAIL, recipient_kind: 'RECEIVES_COPY' }])).body.error.details.reason).toBe('copy_delivery_required');
      expect((await put([{ name: 'X', email: 'x@x.test', copy_delivery: 'ON_SEND' }])).body.error.details.reason).toBe('copy_delivery_not_allowed');
      expect((await put([{ name: 'X', email: 'x@x.test', recipient_kind: 'OBSERVER' }])).body.error.details.reason).toBe('invalid_recipient_kind');
      expect((await put([{ name: 'No email', recipient_kind: 'SIGNER' }])).status).toBe(400);
      expect((await put([{ name: 'A', email: 'dup@x.test' }, { name: 'B', email: 'DUP@x.test', recipient_kind: 'RECEIVES_COPY', copy_delivery: 'ON_SEND' }])).status).toBe(400);
      const eleven = Array.from({ length: 11 }, (_, i) => ({ name: `C${i}`, email: `c${i}@x.test`, recipient_kind: 'RECEIVES_COPY', copy_delivery: 'ON_SEND' }));
      expect((await put([{ name: 'Ann', email: 'ann@mobile.test' }, ...eleven])).body.error.details.reason).toBe('too_many_copy_recipients');
      const ok = await put([
        { name: 'Ann', email: 'ANN@mobile.test', assign_to_me: true },
        { name: 'Casey', email: CC_EMAIL, recipient_kind: 'RECEIVES_COPY', copy_delivery: 'ON_SEND' },
        { name: 'Walk-in', recipient_kind: 'IN_PERSON_SIGNER' },
      ]);
      expect(ok.status).toBe(200);
      expect(ok.body.recipients.map((r: Record<string, unknown>) => [r['recipient_kind'], r['copy_delivery'], r['assigned_to_me'], r['email']])).toEqual([
        ['SIGNER', null, true, 'ANN@mobile.test'],
        ['RECEIVES_COPY', 'ON_SEND', false, CC_EMAIL],
        ['IN_PERSON_SIGNER', null, false, null],
      ]);
      expect(JSON.stringify(ok.body.recipients)).not.toContain(ANN); // the bound user id is never returned
      expect(JSON.stringify(ok.body)).not.toContain('bound_user_id');
      [annSigner, ccSigner, inPerson] = ok.body.recipients.map((r: { id: string }) => r.id);
      // A copy recipient can have no field.
      const field = (signer_id: string, y: number) => ({ envelope_document_id: documentId, signer_id, field_type: 'SIGNATURE', page_number: 0, x: 72, y, width: 120, height: 30 });
      const ccField = await http().put(`/v1/sign/sender/envelopes/${envelopeId}/fields`).set(await H(ANN)).send({ fields: [field(ccSigner, 100)] });
      expect(ccField.status).toBe(400);
      expect(ccField.body.error.details.reason).toBe('copy_recipient_has_fields');
      expect((await http().put(`/v1/sign/sender/envelopes/${envelopeId}/fields`).set(await H(ANN)).send({ fields: [field(annSigner, 100), field(inPerson, 200)] })).status).toBe(200);
      const sent = await http().post(`/v1/sign/sender/envelopes/${envelopeId}/send`).set(await H(ANN)).send({});
      expect(sent.status).toBe(200);
      expect(sent.body.status).toBe('SENT');
      // Only the SIGNER was emailed a link; the copy recipient got a COPY_VIEW grant + ledger event.
      const sessions = (await db.query(`SELECT signer_id, origin FROM "sign"."SigningSession" WHERE envelope_id=$1`, [envelopeId])).rows;
      expect(sessions).toEqual([{ signer_id: annSigner, origin: 'LINK' }]);
      expect((await db.query(`SELECT signer_id, access_kind FROM "sign"."ExecutedAccessGrant" WHERE envelope_id=$1`, [envelopeId])).rows).toEqual([{ signer_id: ccSigner, access_kind: 'COPY_VIEW' }]);
      expect((await db.query(`SELECT count(*)::int n FROM "sign"."SignatureEvent" WHERE envelope_id=$1 AND event_type='COPY_DELIVERY_ISSUED' AND signer_id=$2`, [envelopeId, ccSigner])).rows[0].n).toBe(1);
      expect((await db.query(`SELECT status FROM "sign"."NotificationDelivery" WHERE envelope_id=$1 AND notification_kind='RECIPIENT_COPY'`, [envelopeId])).rows).toEqual([{ status: 'SENT' }]);
      const d = await http().get(`/v1/sign/sender/envelopes/${envelopeId}`).set(await H(ANN));
      expect(d.body.recipients.map((r: { can_remind: boolean }) => r.can_remind)).toEqual([true, false, false]);
    });

    it('POST /v1/sign/signing/copy returns the source documents only — no recipient or signer data; never the executed copy', async () => {
      const token = `copy_${randomUUID().replace(/-/g, '')}`;
      await db.query(`INSERT INTO "sign"."ExecutedAccessGrant" (id, tenant_id, envelope_id, signer_id, token_hash, expires_at, access_kind) VALUES (gen_random_uuid(),$1,$2,$3,$4, now() + interval '1 day','COPY_VIEW')`, [TENANT, envelopeId, ccSigner, hashSigningToken(token)]);
      const res = await http().post('/v1/sign/signing/copy').send({ token });
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['documents', 'sent_at', 'subject']);
      expect(res.body.documents).toHaveLength(1);
      expect(Object.keys(res.body.documents[0]).sort()).toEqual(['content_type', 'source_base64', 'title']);
      expect(res.body.documents[0].source_base64).toBe(pdfBase64);
      const text = JSON.stringify(res.body);
      for (const leak of ['ann@mobile.test', 'ANN@mobile.test', CC_EMAIL, 'Walk-in', annSigner, ccSigner, TENANT, envelopeId]) expect(text).not.toContain(leak);
      expect((await http().post('/v1/sign/signing/executed').send({ token })).status).toBe(401);
      expect((await http().post('/v1/sign/signing/copy').send({ token: `${token}x` })).status).toBe(401);
    });

    it('hosted session: AP route, IN_PERSON_SIGNER only; the token signs through the guest routes with the attested name; other tenants and members are refused', async () => {
      const url = `/v1/sign/sender/envelopes/${envelopeId}/hosted-sessions`;
      const notInPerson = await http().post(url).set(await H(ANN)).send({ signer_id: annSigner });
      expect(notInPerson.status).toBe(409);
      expect(notInPerson.body.error.details.reason).toBe('not_in_person_signer');
      expect((await http().post(url).set(await H(ANN)).send({ signer_id: randomUUID() })).body.error.details.reason).toBe('signer_not_found');
      expect((await http().post(url).set(await H(ANN)).send({})).status).toBe(400);
      expect((await http().post(url).set(await H(OLA, OTHER_TENANT)).send({ signer_id: inPerson })).status).toBe(404);
      expect((await http().post(url).set(await H(BEN)).send({ signer_id: inPerson })).status).toBe(404);
      expect((await http().post(url).send({ signer_id: inPerson })).status).toBe(401);
      const hosted = await http().post(url).set(await H(ANN)).send({ signer_id: inPerson });
      expect(hosted.status).toBe(201);
      expect(hosted.body).toMatchObject({ session_origin: 'HOSTED', signer_id: inPerson });
      expect(Date.parse(hosted.body.expires_at) - Date.now()).toBeLessThanOrEqual(30 * 60 * 1000 + 1000);
      hostedToken = hosted.body.token;
      const text = (await http().post('/v1/sign/signing/disclosure-text').send({ token: hostedToken })).body;
      const noName = await http().post('/v1/sign/signing/disclosure').send({ token: hostedToken, disclosure_version: text.disclosure_version, disclosure_text_hash: text.text_sha256 });
      expect(noName.status).toBe(400);
      expect(noName.body.error.details.reason).toBe('attested_name_required');
      const withName = await http().post('/v1/sign/signing/disclosure').send({ token: hostedToken, disclosure_version: text.disclosure_version, disclosure_text_hash: text.text_sha256, attested_name: 'Walk-in Person' });
      expect(withName.status).toBe(200);
      const ev = (await db.query(`SELECT actor_type, actor_ref FROM "sign"."SignatureEvent" WHERE envelope_id=$1 AND event_type='HOSTED_SESSION_STARTED'`, [envelopeId])).rows;
      expect(ev).toEqual([{ actor_type: 'SERVICE', actor_ref: ANN }]);
    });

    it('self-sign session: only the recipient assigned to the caller; HOSTED and SELF tokens can never be claimed into an inbox', async () => {
      const url = `/v1/sign/sender/envelopes/${envelopeId}/self-sign-session`;
      expect((await http().post(url).set(await H(BEN)).send({})).status).toBe(404);
      expect((await http().post(url).set(await H(OLA, OTHER_TENANT)).send({})).status).toBe(404);
      const self = await http().post(url).set(await H(ANN)).send({});
      expect(self.status).toBe(201);
      expect(self.body).toMatchObject({ session_origin: 'SELF', signer_id: annSigner });
      selfToken = self.body.token;
      expect((await db.query(`SELECT origin, authenticated_user_id FROM "sign"."SigningSession" WHERE token_hash=$1`, [hashSigningToken(selfToken)])).rows).toEqual([{ origin: 'SELF', authenticated_user_id: ANN }]);
      for (const token of [hostedToken, selfToken]) {
        const claim = await http().post('/v1/sign/inbox/claim').set(await H(ANN)).send({ token });
        expect(claim.status).toBe(401);
        expect(claim.body.error.details.reason).toBe('session_origin_not_claimable');
      }
      // The verified email is re-checked: once the account email no longer matches, no session.
      await db.query(`UPDATE identity."User" SET email='ann.moved@mobile.test' WHERE id=$1`, [ANN]);
      try {
        const moved = await http().post(url).set(await H(ANN)).send({});
        expect(moved.status).toBe(403);
        expect(moved.body.error.details.reason).toBe('email_not_verified');
      } finally {
        await db.query(`UPDATE identity."User" SET email='ann@mobile.test' WHERE id=$1`, [ANN]);
      }
    });
  });
});
