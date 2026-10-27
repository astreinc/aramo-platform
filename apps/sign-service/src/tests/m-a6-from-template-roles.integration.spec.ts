import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { type SignTemplateRenderResponse, type SignTemplateSigning } from '@aramo/documents-contracts';
import { DOCUMENT_SOURCE_PROVIDER_PORT, generateSigningToken, signingSessionExpiresAt } from '@aramo/sign';
import { ESIGN_ROLE_PERMISSIONS } from '@aramo/identity';
import cookieParser from 'cookie-parser';
import { SignJWT, exportSPKI, generateKeyPair, type KeyLike } from 'jose';
import { PDFDocument } from 'pdf-lib';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app/app.module.js';
import { DOCUMENT_TEMPLATES_PORT, type DocumentTemplatesPort } from '../app/document-templates-http.adapter.js';
import { SIGN_TEMPLATES_FEATURE, SignFeatureGate } from '../app/sign-feature.gate.js';

// Amendment M-A6 (LOCKED) §3.5–§3.6 — from-template with role binding, END TO END over
// HTTP (real AppModule, real sign migrations, real RBAC). The Documents side (apps/api)
// is a separate service: its signed template-library channel is replaced by a fake that
// answers like the real one. Proves:
//   - each SIGNER role is bound exactly once (Signer.signer_role = role_key, signing_order
//     = role order), fields are assigned through the internal path (SIGNER_NAME included),
//     routing mode / message / subject default from the template, MULTI_SIGNATURE;
//   - provenance (template_ref + template_version_ref) is written once (CHECK + trigger);
//   - refusals happen before any write; cross-tenant templates and envelopes are not found;
//   - CC roles (real M-A5 migration 20261028100000_sign_recipient_kinds): bound as
//     RECEIVES_COPY / ON_COMPLETION with no fields; they never take a SEQUENTIAL turn and
//     never block completion.

const ROOT = resolve(__dirname, '../../../..');
const migrationsOf = (lib: string): string[] => {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};

const AUDIENCE = 'aramo-sign-m-a6-test';
const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();
const ANN = randomUUID();
const OLA = randomUUID();
const TEMPLATE = randomUUID();
const VERSION = randomUUID();

const SIGNING: SignTemplateSigning = {
  roles: [
    { role_key: 'client', label: 'Client', kind: 'SIGNER', order: 1 },
    { role_key: 'agency', label: 'Agency', kind: 'SIGNER', order: 2 },
    { role_key: 'hr_copy', label: 'HR copy', kind: 'CC', order: 3 },
  ],
  routing_mode: 'SEQUENTIAL',
  default_subject: 'Please sign the agreement',
  default_message: 'Template message',
};

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('M-A6 from-template role binding — HTTP end to end', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let module: TestingModule;
  let app: NestExpressApplication;
  let key: KeyLike;
  let pdf: Uint8Array = new Uint8Array();
  let renders = 0;
  const saved: Record<string, string | undefined> = {};

  // The Documents template library, as apps/api answers it: the template is usable only by
  // TENANT; every render freezes a new revision with one block per SIGNER role.
  const documents: DocumentTemplatesPort = {
    async list(i) {
      return {
        items: i.tenant_id === TENANT ? [{ template_id: TEMPLATE, signing: SIGNING } as never] : [],
        unavailable: [],
      };
    },
    async preview() {
      throw new Error('not used');
    },
    async render(i): Promise<SignTemplateRenderResponse> {
      if (i.tenant_id !== TENANT) throw new Error('foreign render must never be attempted');
      renders += 1;
      return {
        document_id: randomUUID(),
        document_revision_ref: randomUUID(),
        source_sha256: createHash('sha256').update(pdf).digest('hex'),
        byte_size: pdf.byteLength,
        title: 'Mutual Agreement',
        template_id: TEMPLATE,
        template_version_id: VERSION,
        version_number: 4,
        signature_fields: (['client', 'agency'] as const).flatMap((role_key, i2) =>
          (['SIGNATURE', 'SIGNER_NAME', 'SIGN_DATE'] as const).map((field_type, j) => ({ field_type, page_number: 0, x: 60 + j * 170, y: 300 - i2 * 90, width: 160, height: 20, role_key })),
        ),
        field_definitions: [],
        signing: SIGNING,
      };
    },
  };

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
  const H = async (sub: string, tenant = TENANT) => ({ Authorization: `Bearer ${await jwt(sub, tenant)}`, 'X-Aramo-Consumer': 'sign' });
  const envelopeCount = async (): Promise<number> => (await db.query(`SELECT count(*)::int AS n FROM "sign"."SignatureEnvelope"`)).rows[0].n;
  const recipients = [
    { role_key: 'agency', name: 'Agency Rep', email: 'agency@x.test' },
    { role_key: 'client', name: 'Client Signer', email: 'client@x.test' },
  ];

  async function member(userId: string, email: string, tenant: string): Promise<void> {
    const m = randomUUID();
    await db.query(`INSERT INTO identity."User" (id, email, display_name, tenant_id, updated_at) VALUES ($1,$2,$2,$3, now())`, [userId, email, tenant]);
    await db.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, updated_at) VALUES ($1,$2,$3, now())`, [m, userId, tenant]);
    await db.query(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) SELECT gen_random_uuid(), $1, r.id FROM identity."Role" r WHERE r.key = 'sign_sender'`, [m]);
    await db.query(`INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at) VALUES (gen_random_uuid(),$1,$2,1, now())`, [tenant, userId]);
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const lib of ['sign', 'identity', 'entitlement', 'metering', 'subscription']) {
      for (const m of migrationsOf(lib)) await db.query(readFileSync(m, 'utf8'));
    }
    for (const [id, slug] of [[TENANT, 'm-a6-co'], [OTHER_TENANT, 'm-a6-other']] as const) {
      await db.query(`INSERT INTO identity."Tenant" (id, name, slug, kind, status, is_active, updated_at) VALUES ($1,$2,$2,'BUSINESS','ACTIVE',true, now())`, [id, slug]);
      for (const c of ['core', 'sign']) await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source) VALUES ($1, $2::entitlement."Capability", 'PROVISIONING')`, [id, c]);
      await db.query(
        `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by) SELECT gen_random_uuid(), $1::uuid, p.id, (SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = p.id AND v.status = 'PUBLISHED'), p.product_key, 'BASE', now(), 'MANUAL', 'integration-test' FROM subscription."Plan" p WHERE p.key = 'aramo-sign-included-v1'`,
        [id],
      );
    }
    await db.query(`INSERT INTO identity."Role" (id, key, description, updated_at) VALUES ($1,'sign_sender','sign_sender', now()) ON CONFLICT (key) DO NOTHING`, [randomUUID()]);
    for (const s of [...ESIGN_ROLE_PERMISSIONS.sign_sender, 'document_template:read']) {
      await db.query(`INSERT INTO identity."Scope" (id, key) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`, [randomUUID(), s]);
      await db.query(
        `INSERT INTO identity."RoleScope" (id, role_id, scope_id) SELECT gen_random_uuid(), r.id, s.id FROM identity."Role" r, identity."Scope" s WHERE r.key = 'sign_sender' AND s.key = $1 ON CONFLICT (role_id, scope_id) DO NOTHING`,
        [s],
      );
    }
    await member(ANN, 'ann@m-a6.test', TENANT);
    await member(OLA, 'ola@m-a6-other.test', OTHER_TENANT);
    const one = await PDFDocument.create();
    one.addPage([612, 792]);
    pdf = await one.save();

    const kp = await generateKeyPair('RS256');
    key = kp.privateKey;
    for (const k of ['DATABASE_URL', 'MAILER_PROVIDER', 'AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY', 'REDIS_URL']) saved[k] = process.env[k];
    process.env['DATABASE_URL'] = url;
    process.env['MAILER_PROVIDER'] = 'stub';
    process.env['AUTH_AUDIENCE'] = AUDIENCE;
    process.env['AUTH_PUBLIC_KEY'] = await exportSPKI(kp.publicKey);
    delete process.env['REDIS_URL'];
    module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DOCUMENT_TEMPLATES_PORT)
      .useValue(documents)
      .overrideProvider(DOCUMENT_SOURCE_PROVIDER_PORT)
      .useValue({ getSourcePdf: async () => pdf })
      .overrideProvider(SignFeatureGate)
      .useValue(new SignFeatureGate({ [SIGN_TEMPLATES_FEATURE]: 'AVAILABLE' }))
      .compile();
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

  it('binds every SIGNER role once in role order; fields through the internal path; template defaults; provenance', async () => {
    const res = await http()
      .post('/v1/sign/sender/envelopes/from-template')
      .set(await H(ANN))
      .send({ template_id: TEMPLATE, values: { 'requisition.title': 'Analyst' }, recipients });
    expect(res.status).toBe(201);
    const id = res.body.envelope.id as string;
    const env = await db.query(
      `SELECT subject, message, routing_mode, execution_mode, template_ref::text, template_version_ref::text, source_application FROM "sign"."SignatureEnvelope" WHERE id = $1`,
      [id],
    );
    expect(env.rows[0]).toEqual({
      subject: 'Please sign the agreement',
      message: 'Template message',
      routing_mode: 'SEQUENTIAL',
      execution_mode: 'MULTI_SIGNATURE',
      template_ref: TEMPLATE,
      template_version_ref: VERSION,
      source_application: 'aramo-sign',
    });
    const signers = await db.query(`SELECT id, name, email, signer_role, signing_order FROM "sign"."Signer" WHERE envelope_id = $1 ORDER BY signing_order`, [id]);
    expect(signers.rows.map((r) => `${r.signing_order}:${r.signer_role}:${r.email}`)).toEqual(['1:client:client@x.test', '2:agency:agency@x.test']);
    const fields = await db.query(
      `SELECT f.field_type, s.signer_role FROM "sign"."SignatureField" f JOIN "sign"."Signer" s ON s.id = f.signer_id WHERE s.envelope_id = $1 ORDER BY s.signing_order, f.y DESC, f.x`,
      [id],
    );
    expect(fields.rows.map((r) => `${r.signer_role}:${r.field_type}`)).toEqual([
      'client:SIGNATURE',
      'client:SIGNER_NAME',
      'client:SIGN_DATE',
      'agency:SIGNATURE',
      'agency:SIGNER_NAME',
      'agency:SIGN_DATE',
    ]);
    expect(res.body.signing).toEqual(SIGNING);
    expect(res.body.envelope.recipients).toHaveLength(2);
  });

  it('provenance is written once and paired (CHECK + trigger)', async () => {
    const res = await http().post('/v1/sign/sender/envelopes/from-template').set(await H(ANN)).send({ template_id: TEMPLATE, recipients, routing_mode: 'PARALLEL', message: 'Hi' });
    expect(res.status).toBe(201);
    const id = res.body.envelope.id as string;
    expect((await db.query(`SELECT routing_mode, message FROM "sign"."SignatureEnvelope" WHERE id = $1`, [id])).rows[0]).toEqual({ routing_mode: 'PARALLEL', message: 'Hi' });
    await expect(db.query(`UPDATE "sign"."SignatureEnvelope" SET template_ref = $2 WHERE id = $1`, [id, randomUUID()])).rejects.toThrow(/written once/);
    await expect(db.query(`UPDATE "sign"."SignatureEnvelope" SET template_ref = NULL, template_version_ref = NULL WHERE id = $1`, [id])).rejects.toThrow(/written once/);
    const plain = await http().post('/v1/sign/sender/envelopes').set(await H(ANN)).send({ subject: 'Plain' });
    await expect(db.query(`UPDATE "sign"."SignatureEnvelope" SET template_ref = $2 WHERE id = $1`, [plain.body.id, randomUUID()])).rejects.toThrow(/template_provenance_pair_check/);
  });

  it('refusals happen before any write (no render, no envelope)', async () => {
    const before = await envelopeCount();
    const rendersBefore = renders;
    const reason = async (body: Record<string, unknown>): Promise<[number, unknown]> => {
      const r = await http().post('/v1/sign/sender/envelopes/from-template').set(await H(ANN)).send({ template_id: TEMPLATE, ...body });
      return [r.status, r.body?.error?.details?.reason];
    };
    expect(await reason({ recipients: [recipients[0]] })).toEqual([400, 'role_unbound']);
    expect(await reason({ recipients: [...recipients, { role_key: 'client', name: 'Twice', email: 'twice@x.test' }] })).toEqual([400, 'role_bound_twice']);
    expect(await reason({ recipients, signer: { name: 'S', email: 's@x.test' } })).toEqual([400, 'signer_and_recipients']);
    expect(await reason({ recipients: [recipients[0], { ...recipients[1], email: 'AGENCY@x.test' }] })).toEqual([400, 'duplicate_email']);
    expect(await envelopeCount()).toBe(before);
    expect(renders).toBe(rendersBefore);
  });

  it('cross-tenant — another tenant cannot use the template nor read the envelope', async () => {
    const before = await envelopeCount();
    const res = await http().post('/v1/sign/sender/envelopes/from-template').set(await H(OLA, OTHER_TENANT)).send({ template_id: TEMPLATE, recipients });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TEMPLATE_NOT_FOUND');
    expect(await envelopeCount()).toBe(before);
    const mine = await http().post('/v1/sign/sender/envelopes/from-template').set(await H(ANN)).send({ template_id: TEMPLATE, recipients });
    expect((await http().get(`/v1/sign/sender/envelopes/${mine.body.envelope.id}`).set(await H(OLA, OTHER_TENANT))).status).toBe(404);
  });

  it('2 SIGNER roles + 1 CC role on the real M-A5 schema — kinds and copy timing; the CC has no fields and never blocks the SEQUENTIAL turn or completion', async () => {
    const cc = [{ role_key: 'hr_copy', name: 'HR', email: 'hr@x.test' }];
    const ok = await http().post('/v1/sign/sender/envelopes/from-template').set(await H(ANN)).send({ template_id: TEMPLATE, values: { 'requisition.title': 'Analyst' }, recipients, cc });
    expect(ok.status).toBe(201);
    const id = ok.body.envelope.id as string;
    const rows = await db.query(
      `SELECT id, signer_role, signing_order, recipient_kind, copy_delivery, (SELECT count(*)::int FROM "sign"."SignatureField" f WHERE f.signer_id = s.id) AS fields FROM "sign"."Signer" s WHERE envelope_id = $1 ORDER BY signing_order`,
      [id],
    );
    expect(rows.rows.map(({ id: _id, ...r }) => r)).toEqual([
      { signer_role: 'client', signing_order: 1, recipient_kind: 'SIGNER', copy_delivery: null, fields: 3 },
      { signer_role: 'agency', signing_order: 2, recipient_kind: 'SIGNER', copy_delivery: null, fields: 3 },
      { signer_role: 'hr_copy', signing_order: 3, recipient_kind: 'RECEIVES_COPY', copy_delivery: 'ON_COMPLETION', fields: 0 },
    ]);
    const [client, agency, copy] = rows.rows.map((r) => r.id as string) as [string, string, string];
    // M-A6 §3.3 — the role's printed name is filled by Sign (SIGNER_PROFILE).
    expect((await db.query(`SELECT DISTINCT name_mode FROM "sign"."SignatureField" f JOIN "sign"."Signer" s ON s.id = f.signer_id WHERE s.envelope_id = $1 AND f.field_type = 'SIGNER_NAME'`, [id])).rows).toEqual([{ name_mode: 'SIGNER_PROFILE' }]);
    // The copy recipient is listed as a copy, single-signer routing is not assumed.
    expect(ok.body.envelope.recipients.map((r: { recipient_kind: string; copy_delivery: string | null }) => [r.recipient_kind, r.copy_delivery])).toEqual([
      ['SIGNER', null],
      ['SIGNER', null],
      ['RECEIVES_COPY', 'ON_COMPLETION'],
    ]);

    const sent = await http().post(`/v1/sign/sender/envelopes/${id}/send`).set(await H(ANN)).send({});
    expect(sent.status).toBe(200);
    // SEQUENTIAL — only the first signing role is invited; the copy recipient never gets a session.
    expect((await db.query(`SELECT signer_id FROM "sign"."SigningSession" WHERE envelope_id = $1`, [id])).rows).toEqual([{ signer_id: client }]);

    const token = async (signer_id: string): Promise<string> => {
      const t = generateSigningToken();
      await db.query(
        `INSERT INTO "sign"."SigningSession" (id, tenant_id, envelope_id, signer_id, token_hash, status, expires_at, origin) VALUES ($1,$2,$3,$4,$5,'ISSUED',$6,'LINK')`,
        [randomUUID(), TENANT, id, signer_id, t.hash, signingSessionExpiresAt(new Date())],
      );
      return t.raw;
    };
    const signAs = async (signer_id: string): Promise<string> => {
      const t = await token(signer_id);
      const text = (await http().post('/v1/sign/signing/disclosure-text').send({ token: t })).body;
      expect((await http().post('/v1/sign/signing/disclosure').send({ token: t, disclosure_version: text.disclosure_version, disclosure_text_hash: text.text_sha256 })).status).toBe(200);
      const mine = (await db.query(`SELECT id, field_type FROM "sign"."SignatureField" WHERE signer_id = $1`, [signer_id])).rows as { id: string; field_type: string }[];
      for (const f of mine) {
        if (f.field_type === 'SIGNER_NAME') continue; // server-filled
        const value = f.field_type === 'SIGN_DATE' ? '2026-10-27' : 'Signed';
        expect((await http().post(`/v1/sign/signing/fields/${f.id}/fill`).send({ token: t, value, signature_method: f.field_type === 'SIGNATURE' ? 'TYPED' : undefined })).status).toBe(200);
      }
      const done = await http().post('/v1/sign/signing/complete').send({ token: t });
      expect(done.status).toBe(200);
      return done.body.envelope_status as string;
    };

    // The agency role cannot act before its turn; the copy recipient never takes one.
    expect(await signAs(client)).toBe('IN_PROGRESS');
    const intents = (await db.query(`SELECT signer_id FROM "sign"."NotificationDelivery" WHERE envelope_id = $1 AND notification_kind = 'SIGNATURE_REQUEST'`, [id])).rows.map((r) => r.signer_id);
    expect(intents).toContain(agency);
    expect(intents).not.toContain(copy);
    expect(await signAs(agency)).toBe('COMPLETED');
    expect((await db.query(`SELECT status FROM "sign"."SignatureEnvelope" WHERE id = $1`, [id])).rows[0].status).toBe('COMPLETED');
    expect((await db.query(`SELECT status FROM "sign"."Signer" WHERE id = $1`, [copy])).rows[0].status).toBe('PENDING');
    expect((await db.query(`SELECT count(*)::int AS n FROM "sign"."SigningSession" WHERE signer_id = $1`, [copy])).rows[0].n).toBe(0);
  });
});
