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

// Aramo Sign Mobile (W7) — sender draft contracts END TO END over HTTP (real
// AppModule, real migrations, real RBAC, RS256 browser and native tokens):
//   D-W6-1  upload → revision + ETag, chained straight into the next If-Match;
//   D-W6-2  documents[].pages stored at upload; filled on read for an older
//           document WITHOUT changing the envelope revision;
//   D-W6-3  DELETE a DRAFT: tombstone + ledger DRAFT_DELETED, children and stored
//           bytes gone, hidden from every console read; cross-user / cross-tenant
//           404, non-draft 409, stale 412, native 428; the database refuses to
//           send or restore a deleted draft;
//   B-11    user.identity_provider from the recorded sign-in provider.

const ROOT = resolve(__dirname, '../../../..');
const migrationsOf = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};

const AUDIENCE = 'aramo-sign-mobile-drafts-test';
const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();
const ANN = randomUUID();
const BEN = randomUUID(); // same tenant, no organization read
const OLA = randomUUID(); // a sender in OTHER_TENANT

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Sign Mobile sender drafts — HTTP end to end', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let module: TestingModule;
  let app: NestExpressApplication;
  let key: KeyLike;
  let twoPagePdf = '';
  let onePagePdf: Uint8Array = new Uint8Array();
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
    async deleteOwnedSource(k: string) {
      owned.delete(k);
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
  const etag = (id: string, rev: number) => `"${id}.${rev}"`;

  async function member(userId: string, email: string, tenant: string): Promise<void> {
    const m = randomUUID();
    await db.query(`INSERT INTO identity."User" (id, email, display_name, tenant_id, updated_at) VALUES ($1,$2,$2,$3, now())`, [userId, email, tenant]);
    await db.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, updated_at) VALUES ($1,$2,$3, now())`, [m, userId, tenant]);
    await db.query(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) SELECT gen_random_uuid(), $1, r.id FROM identity."Role" r WHERE r.key = 'sign_sender'`, [m]);
    await db.query(`INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at) VALUES (gen_random_uuid(),$1,$2,1, now())`, [tenant, userId]);
  }

  // A browser-authored draft of ANN with one uploaded document and one recipient + field.
  async function preparedDraft(): Promise<{ id: string; revision: number; docId: string; objectKey: string }> {
    const created = await http().post('/v1/sign/sender/envelopes').set(await H(ANN)).send({ subject: 'Draft to delete' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const up = await http().post(`/v1/sign/sender/envelopes/${id}/documents`).set(await H(ANN)).send({ filename: 'a.pdf', content_base64: twoPagePdf });
    expect(up.status).toBe(201);
    const r = await http().put(`/v1/sign/sender/envelopes/${id}/recipients`).set(await H(ANN)).send({ recipients: [{ name: 'Bob', email: 'bob@x.test' }] });
    expect(r.status).toBe(200);
    const f = await http()
      .put(`/v1/sign/sender/envelopes/${id}/fields`)
      .set(await H(ANN))
      .send({ fields: [{ envelope_document_id: up.body.id, signer_id: r.body.recipients[0].id, field_type: 'SIGNATURE', page_number: 1, x: 72, y: 72, width: 180, height: 40 }] });
    expect(f.status).toBe(200);
    const key = (await db.query(`SELECT source_object_key FROM "sign"."EnvelopeDocument" WHERE id = $1`, [up.body.id])).rows[0].source_object_key as string;
    return { id, revision: f.body.revision as number, docId: up.body.id as string, objectKey: key };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const lib of ['sign', 'identity', 'entitlement', 'metering', 'subscription']) {
      for (const m of migrationsOf(lib)) await db.query(readFileSync(m, 'utf8'));
    }
    for (const [id, slug] of [[TENANT, 'drafts-co'], [OTHER_TENANT, 'drafts-other']] as const) {
      await db.query(`INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, updated_at) VALUES ($1,$2,$2,'BUSINESS','ACTIVE',true, now())`, [id, slug]);
      for (const c of ['core', 'sign']) await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1, $2::entitlement."Capability")`, [id, c]);
      await db.query(
        `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, period_anchor, source, created_by) SELECT gen_random_uuid(), $1::uuid, p.id, now(), 'MANUAL', 'integration-test' FROM subscription."Plan" p WHERE p.key = 'aramo-sign-included-v1'`,
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
    await member(ANN, 'ann@drafts.test', TENANT);
    await member(BEN, 'ben@drafts.test', TENANT);
    await member(OLA, 'ola@drafts-other.test', OTHER_TENANT);
    const two = await PDFDocument.create();
    two.addPage([612, 792]);
    two.addPage([842, 595]);
    twoPagePdf = Buffer.from(await two.save()).toString('base64');
    const one = await PDFDocument.create();
    one.addPage([595.28, 841.89]);
    onePagePdf = await one.save();

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

  describe('D-W6-1 / D-W6-2 — upload revision and page sizes', () => {
    it('a native upload answers with the new revision and ETag, which the next write uses as If-Match directly', async () => {
      const native = await H(ANN, TENANT, true);
      const created = await http().post('/v1/sign/sender/envelopes').set(native).send({ subject: 'Chained' });
      const id = created.body.id as string;
      const up = await http().post(`/v1/sign/sender/envelopes/${id}/documents`).set({ ...native, 'If-Match': etag(id, 1) }).send({ filename: 'a.pdf', content_base64: twoPagePdf });
      expect(up.status).toBe(201);
      expect(up.body).toMatchObject({ envelope_id: id, revision: 2, page_count: 2, pages: [{ width: 612, height: 792 }, { width: 842, height: 595 }] });
      expect(up.headers['etag']).toBe(etag(id, 2));
      const renamed = await http().patch(`/v1/sign/sender/envelopes/${id}/documents/${up.body.id}`).set({ ...native, 'If-Match': up.headers['etag'] }).send({ title: 'Renamed' });
      expect(renamed.status).toBe(200);
      expect(renamed.headers['etag']).toBe(etag(id, 3));
      // The detail reports the stored page sizes per document.
      const d = await http().get(`/v1/sign/sender/envelopes/${id}`).set(native);
      expect(d.body.documents[0]).toMatchObject({ id: up.body.id, page_count: 2, pages: [{ width: 612, height: 792 }, { width: 842, height: 595 }] });
      const stored = await db.query(`SELECT tenant_id, pages FROM "sign"."SignEnvelopeDocumentPages" WHERE envelope_document_id = $1`, [up.body.id]);
      expect(stored.rows).toEqual([{ tenant_id: TENANT, pages: [{ width: 612, height: 792 }, { width: 842, height: 595 }] }]);
    });

    it('an older document without stored sizes is measured on read, stored once, and the read never changes the revision', async () => {
      const created = await http().post('/v1/sign/sender/envelopes').set(await H(ANN)).send({ subject: 'Legacy' });
      const id = created.body.id as string;
      const docId = randomUUID();
      const k = `esign/source/${TENANT}/${id}/legacy`;
      owned.set(k, onePagePdf);
      await db.query(
        `INSERT INTO "sign"."EnvelopeDocument" (id, tenant_id, envelope_id, source_mode, source_object_key, content_type, byte_size, title, source_sha256, ordinal) VALUES ($1,$2,$3,'OWNED',$4,'application/pdf',$5,'Legacy',$6,0)`,
        [docId, TENANT, id, k, onePagePdf.byteLength, createHash('sha256').update(onePagePdf).digest('hex')],
      );
      const first = await http().get(`/v1/sign/sender/envelopes/${id}`).set(await H(ANN));
      expect(first.body.documents[0]).toMatchObject({ page_count: 1, pages: [{ width: 595.28, height: 841.89 }] });
      const second = await http().get(`/v1/sign/sender/envelopes/${id}`).set(await H(ANN));
      expect(second.body.revision).toBe(first.body.revision);
      expect(second.headers['etag']).toBe(first.headers['etag']);
      expect((await db.query(`SELECT count(*)::int AS n FROM "sign"."SignEnvelopeDocumentPages" WHERE envelope_document_id = $1`, [docId])).rows[0].n).toBe(1);
    });
  });

  describe('D-W6-3 — DELETE /v1/sign/sender/envelopes/:id', () => {
    it('deletes a draft: 204, children and stored bytes gone, tombstone scrubbed, DRAFT_DELETED on the ledger, hidden from every console read', async () => {
      const draft = await preparedDraft();
      expect(owned.has(draft.objectKey)).toBe(true);
      const native = await H(ANN, TENANT, true);
      const res = await http().delete(`/v1/sign/sender/envelopes/${draft.id}`).set({ ...native, 'If-Match': etag(draft.id, draft.revision) });
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      const row = (await db.query(`SELECT status, subject, message, deleted_at FROM "sign"."SignatureEnvelope" WHERE id = $1`, [draft.id])).rows[0];
      expect(row).toMatchObject({ status: 'DRAFT', subject: 'Deleted draft', message: null });
      expect(row.deleted_at).not.toBeNull();
      for (const t of ['EnvelopeDocument', 'Signer']) {
        expect((await db.query(`SELECT count(*)::int AS n FROM "sign"."${t}" WHERE envelope_id = $1`, [draft.id])).rows[0].n).toBe(0);
      }
      expect((await db.query(`SELECT count(*)::int AS n FROM "sign"."SignatureField" WHERE envelope_document_id = $1`, [draft.docId])).rows[0].n).toBe(0);
      expect((await db.query(`SELECT count(*)::int AS n FROM "sign"."SignEnvelopeDocumentPages" WHERE envelope_document_id = $1`, [draft.docId])).rows[0].n).toBe(0);
      expect(owned.has(draft.objectKey)).toBe(false);
      const ledger = await db.query(`SELECT event_type, actor_ref, payload FROM "sign"."SignatureEvent" WHERE envelope_id = $1 ORDER BY occurred_at, id`, [draft.id]);
      expect(ledger.rows.at(-1)).toEqual({ event_type: 'DRAFT_DELETED', actor_ref: ANN, payload: { document_count: 1, recipient_count: 1 } });
      expect(ledger.rows.map((r) => r.event_type)).toContain('ENVELOPE_CREATED');

      const H1 = await H(ANN);
      expect((await http().get(`/v1/sign/sender/envelopes/${draft.id}`).set(H1)).status).toBe(404);
      const list = await http().get('/v1/sign/sender/envelopes?tab=all').set(H1);
      expect(list.body.items.map((e: { id: string }) => e.id)).not.toContain(draft.id);
      const activity = await http().get('/v1/sign/sender/activity').set(H1);
      expect(activity.body.items.map((e: { envelope_id: string }) => e.envelope_id)).not.toContain(draft.id);
      // Deleting again, or any further write, reads as not found.
      expect((await http().delete(`/v1/sign/sender/envelopes/${draft.id}`).set(H1)).status).toBe(404);
      expect((await http().patch(`/v1/sign/sender/envelopes/${draft.id}`).set(H1).send({ subject: 'Back' })).status).toBe(404);
    });

    it('the database refuses to send or restore a deleted draft', async () => {
      const draft = await preparedDraft();
      expect((await http().delete(`/v1/sign/sender/envelopes/${draft.id}`).set(await H(ANN))).status).toBe(204);
      await expect(db.query(`UPDATE "sign"."SignatureEnvelope" SET status = 'SENT', sent_at = now() WHERE id = $1`, [draft.id])).rejects.toThrow(/deleted_draft_check/);
      await expect(db.query(`UPDATE "sign"."SignatureEnvelope" SET deleted_at = NULL WHERE id = $1`, [draft.id])).rejects.toThrow(/final/);
    });

    it('another member of the tenant and a user of another tenant get 404; nothing is deleted', async () => {
      const draft = await preparedDraft();
      for (const h of [await H(BEN), await H(OLA, OTHER_TENANT), await H(OLA, OTHER_TENANT, true)]) {
        const res = await http().delete(`/v1/sign/sender/envelopes/${draft.id}`).set({ ...h, 'If-Match': etag(draft.id, draft.revision) });
        expect(res.status).toBe(404);
      }
      expect((await db.query(`SELECT deleted_at FROM "sign"."SignatureEnvelope" WHERE id = $1`, [draft.id])).rows[0].deleted_at).toBeNull();
      expect((await http().get(`/v1/sign/sender/envelopes/${draft.id}`).set(await H(ANN))).status).toBe(200);
    });

    it('a native delete without If-Match is 428, a stale one 412 with the current revision (browser too); nothing is deleted', async () => {
      const draft = await preparedDraft();
      const missing = await http().delete(`/v1/sign/sender/envelopes/${draft.id}`).set(await H(ANN, TENANT, true));
      expect(missing.status).toBe(428);
      expect(missing.body.error.details.reason).toBe('precondition_required');
      for (const native of [true, false]) {
        const stale = await http().delete(`/v1/sign/sender/envelopes/${draft.id}`).set({ ...(await H(ANN, TENANT, native)), 'If-Match': etag(draft.id, draft.revision - 1) });
        expect(stale.status).toBe(412);
        expect(stale.body.error.details).toEqual({ reason: 'revision_mismatch', current_revision: draft.revision });
      }
      expect((await db.query(`SELECT deleted_at FROM "sign"."SignatureEnvelope" WHERE id = $1`, [draft.id])).rows[0].deleted_at).toBeNull();
    });

    it('a sent envelope is refused 409 envelope_not_draft', async () => {
      const id = randomUUID();
      await db.query(`INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by, sent_at, expires_at) VALUES ($1,$2,'Sent','SENT','SINGLE_SIGNATURE',$3, now(), now() + interval '30 days')`, [id, TENANT, ANN]);
      const rev = (await db.query(`SELECT revision FROM "sign"."SignatureEnvelope" WHERE id = $1`, [id])).rows[0].revision as number;
      const res = await http().delete(`/v1/sign/sender/envelopes/${id}`).set({ ...(await H(ANN, TENANT, true)), 'If-Match': etag(id, rev) });
      expect(res.status).toBe(409);
      expect(res.body.error.details.reason).toBe('envelope_not_draft');
      expect((await db.query(`SELECT status, deleted_at FROM "sign"."SignatureEnvelope" WHERE id = $1`, [id])).rows[0]).toEqual({ status: 'SENT', deleted_at: null });
    });

    it('a draft another application created is refused (managed_by_source_application)', async () => {
      const id = randomUUID();
      await db.query(`INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by, source_application) VALUES ($1,$2,'ATS draft','DRAFT','SINGLE_SIGNATURE',$3,'aramo-ats')`, [id, TENANT, ANN]);
      const res = await http().delete(`/v1/sign/sender/envelopes/${id}`).set(await H(ANN));
      expect(res.status).toBe(409);
      expect(res.body.error.details.reason).toBe('managed_by_source_application');
    });
  });

  describe('B-11 — user.identity_provider', () => {
    it('reports the provider recorded on the user’s sign-in link; null for another user without one', async () => {
      const ext = randomUUID();
      await db.query(`INSERT INTO identity."ExternalIdentity" (id, provider, provider_subject, user_id, updated_at) VALUES ($1,'cognito',$2,$3, now())`, [ext, `sub-${ext}`, ANN]);
      await db.query(`INSERT INTO identity."ExternalIdentityIdp" (external_identity_id, idp) VALUES ($1,'microsoft')`, [ext]);
      const ann = await http().get('/v1/sign/sender/context').set(await H(ANN));
      expect(ann.status).toBe(200);
      expect(ann.body.user.identity_provider).toBe('microsoft');
      const ben = await http().get('/v1/sign/sender/context').set(await H(BEN));
      expect(ben.body.user.identity_provider).toBeNull();
    });
  });
});
