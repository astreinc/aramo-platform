import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, resolveEntitlementMigrations, resolveIdentityMigrations } from '@aramo/common';
import { signEsignServiceRequest, signTemplateBodyDigest } from '@aramo/documents-contracts';
import { ObjectStorageService } from '@aramo/object-storage';
import { EFFECTIVE_AUTHORIZATION_RESOLVER, PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import express from 'express';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { PDFDocument } from 'pdf-lib';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app.module.js';

import { ConfigurableTestResolver } from './support/test-auth-harness.js';
import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';
import { grantTemplateProductEntitlements } from './helpers/template-product-entitlements.js';

// TEMPLATE-FIELDS-1 (Aramo-Template-Fields-1-Directive-v1_0-LOCKED) §5.3 / §5.5 — end to end on a
// booted AppModule over real Postgres 17:
//   - the platform places a signature box, an initials box and a checkbox inside the Employee
//     Handbook text (content + rows in one save), each §3.7 save refusal returns its code and saves
//     nothing, previews (labelled boxes) and publishes; an `ats` template refuses publishing;
//   - a company adopts it (the rows are copied), edits the wording around the fields, cannot
//     remove one (fields_platform_only) nor add one, and approves it;
//   - "Use" in Sign (the signed S2S render) returns every field with its render position, the
//     revision's render_manifest records them, and the employee (inline SIGNATURE) gets no
//     appended signature block while the manager keeps theirs.
// The signed PDF and the certificate are produced by sign-service from these positions (its own
// specs); this spec stops at the frozen document Sign receives. Skipped unless ARAMO_RUN_INTEGRATION=1.
const __authzTestResolver = new ConfigurableTestResolver();
const ROOT = resolve(__dirname, '../../../..');
const AUDIENCE = 'aramo-template-fields-1-http-spec';
const ALG = 'RS256';
const SECRET = 'template-fields-1-s2s-secret';
const ENTITLEMENT_MIGRATIONS = resolveEntitlementMigrations(ROOT);
function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
const TENANT = '01900000-0000-7000-8000-0000000002f1';
const OPERATOR = '00000000-0000-7000-8000-0000000002f2';
const TENANT_ADMIN = '00000000-0000-7000-8000-0000000002f3';
const RTR = 'd0c50005-0000-7000-8000-000000000001';
const MANAGE = ['platform:tenant:read', 'platform:document_template:read', 'platform:document_template:manage'];

const SIGNING = {
  roles: [
    { role_key: 'employee', label: 'Employee', kind: 'SIGNER', order: 1 },
    { role_key: 'manager', label: 'Manager', kind: 'SIGNER', order: 2 },
  ],
  routing_mode: 'PARALLEL',
};
const HANDBOOK =
  '<h2>Acknowledgement</h2><p>I have read the Employee Handbook. Initials: <span data-sign-field="employee_initials"></span></p>' +
  '<ul><li>I accept the IT policy <span data-sign-field="it_policy"></span></li></ul>' +
  '<p>Signed: <span data-sign-field="employee_signature"></span></p>';
const FIELDS = [
  { field_key: 'employee_initials', field_type: 'INITIALS', signer_role: 'employee', required: true, ordinal: 0 },
  { field_key: 'it_policy', field_type: 'CHECKBOX', signer_role: 'employee', required: false, ordinal: 1, label: 'IT policy' },
  { field_key: 'employee_signature', field_type: 'SIGNATURE', signer_role: 'employee', required: true, ordinal: 2 },
];
const content = (html: string, title = 'Employee Handbook') => ({ render_schema_version: 'rtr-html-v3', title, html, signing: SIGNING });

// Fails with the response body in the message (the error code and details), not just the status.
function expectStatus(res: { status: number; body: unknown }, status: number): void {
  expect(res.status, JSON.stringify(res.body).slice(0, 800)).toBe(status);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('TEMPLATE-FIELDS-1 fields in the text — HTTP (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let module: TestingModule;
  let db: Client;
  let port = 0;
  let savedEnv: Partial<Record<string, string | undefined>> = {};
  let operatorJwt = '';
  let tenantJwt = '';
  let templateId = '';
  let draftId = '';
  let copyId = '';
  let copyVersionId = '';
  const objects = new Map<string, Buffer>();

  async function signJwt(key: unknown, args: { sub: string; consumer: string; tenant: string; scopes: string[] }): Promise<string> {
    return new SignJWT({ sub: args.sub, consumer_type: args.consumer, actor_kind: 'user', tenant_id: args.tenant, authz_version: __authzTestResolver.grant(args.tenant, args.sub, args.scopes) })
      .setProtectedHeader({ alg: ALG }).setIssuedAt().setIssuer('Aramo Core Auth').setAudience(AUDIENCE).setExpirationTime('1h')
      .sign(key as never);
  }
  const url = (p: string): string => `http://127.0.0.1:${port}${p}`;
  async function call(jwt: string, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(url(path), {
      method,
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (text.length > 0 ? JSON.parse(text) : {}) as Record<string, unknown> };
  }
  async function s2sRender(template: string, body: unknown, key: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const q = new URLSearchParams({ tenant_id: TENANT, idempotency_key: key, body_sha256: signTemplateBodyDigest(body) });
    const full = url(`/v1/documents/esign/templates/${template}/render?${q.toString()}`);
    const headers = { 'content-type': 'application/json', ...signEsignServiceRequest({ method: 'POST', url: full, secret: SECRET, nowSec: Math.floor(Date.now() / 1000) }) };
    const res = await fetch(full, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: (text.length > 0 ? JSON.parse(text) : {}) as Record<string, unknown> };
  }
  const reasonOf = (b: Record<string, unknown>) => ((b['error'] as { details?: { reason?: string } } | undefined)?.details?.reason ?? null);
  const rowCount = async (versionId: string) => Number((await db.query(`SELECT count(*)::int c FROM documents."TemplateFieldDefinition" WHERE template_version_id = $1`, [versionId])).rows[0].c);

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const dburl = container.getConnectionUri();
    db = new Client({ connectionString: dburl });
    await db.connect();
    for (const p of resolveIdentityMigrations(ROOT)) await db.query(readFileSync(p, 'utf8'));
    for (const m of ENTITLEMENT_MIGRATIONS) await db.query(readFileSync(m, 'utf8'));
    for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));
    for (const t of [TENANT, PLATFORM_TENANT_SENTINEL_ID]) await ensureWriteFreezeTenant((s) => db.query(s), t);
    await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source) VALUES ($1::uuid,'core', 'PROVISIONING') ON CONFLICT DO NOTHING`, [TENANT]);
    await grantTemplateProductEntitlements((q, params) => db.query(q, params), TENANT);
    // With the identity schema present the DOC-TEMPLATE-LIB-1 T-3 migration seeds a live Aramo
    // RTR default; one live default per document type means this spec's handbook could never be
    // published. Withdraw the seeded one (effective yesterday) so the handbook is the live default.
    await db.query(
      `UPDATE documents."DocumentTemplate" SET withdraw_notice_at = now() - interval '2 days', withdraw_effective_at = now() - interval '1 day'
        WHERE owner_scope = 'PLATFORM' AND document_type_id = $1`,
      [RTR],
    );

    const kp = await generateKeyPair(ALG);
    const publicPem = await exportSPKI(kp.publicKey as never);
    savedEnv = {
      DATABASE_URL: process.env['DATABASE_URL'],
      AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
      AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
      ARAMO_ENV: process.env['ARAMO_ENV'],
      SIGN_WEBHOOK_SIGNING_SECRET: process.env['SIGN_WEBHOOK_SIGNING_SECRET'],
      SIGN_S2S_AUTH_MODE: process.env['SIGN_S2S_AUTH_MODE'],
    };
    process.env['DATABASE_URL'] = dburl;
    process.env['AUTH_AUDIENCE'] = AUDIENCE;
    process.env['AUTH_PUBLIC_KEY'] = publicPem;
    process.env['ARAMO_ENV'] = 'itest';
    process.env['SIGN_WEBHOOK_SIGNING_SECRET'] = SECRET;
    delete process.env['SIGN_S2S_AUTH_MODE'];
    operatorJwt = await signJwt(kp.privateKey, { sub: OPERATOR, consumer: 'platform', tenant: PLATFORM_TENANT_SENTINEL_ID, scopes: MANAGE });
    tenantJwt = await signJwt(kp.privateKey, { sub: TENANT_ADMIN, consumer: 'recruiter', tenant: TENANT, scopes: ['auth:session:read', 'document_template:read', 'document_template:author', 'document_template:manage'] });

    const storage = {
      putObjectBytes: async (i: { storage_key: string; body: Buffer }) => {
        objects.set(i.storage_key, i.body);
        return { storage_ref: i.storage_key, sha256: createHash('sha256').update(i.body).digest('hex') };
      },
      getObjectBytes: async (i: { storage_key: string }) => objects.get(i.storage_key) ?? Buffer.alloc(0),
    };
    module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EFFECTIVE_AUTHORIZATION_RESOLVER)
      .useValue(__authzTestResolver)
      .overrideProvider(ObjectStorageService)
      .useValue(storage)
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    (app.getHttpAdapter().getInstance() as ReturnType<typeof express>).use(express.json());
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
    await app.init();
    const server = await app.listen(0);
    port = (server.address() as AddressInfo).port;

    const created = await call(operatorJwt, 'POST', '/platform/document-templates', { document_type_id: RTR, name: 'Employee Handbook', template_kind: 'GENERATED', products: ['sign'] });
    expectStatus(created, 201);
    templateId = created.body['id'] as string;
    const opened = await call(operatorJwt, 'POST', `/platform/document-templates/${templateId}/versions`, { render_schema_version: 'rtr-html-v3', field_schema: content('<p>Draft</p>') });
    expectStatus(opened, 201);
    draftId = opened.body['id'] as string;
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await container?.stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }, 60_000);

  it('each §3.7 save refusal returns its code and saves nothing', async () => {
    const patch = (html: string, fields: unknown[]) => call(operatorJwt, 'PATCH', `/platform/document-templates/versions/${draftId}`, { render_schema_version: 'rtr-html-v3', field_schema: content(html), fields });
    expect(reasonOf((await patch('<h2>Title <span data-sign-field="employee_signature"></span></h2>', [FIELDS[2]])).body)).toBe('field_position_not_allowed');
    const mismatch = await patch(HANDBOOK, FIELDS.slice(0, 2));
    expect(reasonOf(mismatch.body)).toBe('field_marker_mismatch');
    expect((mismatch.body['error'] as { details: { missing: string[] } }).details.missing).toEqual(['employee_signature']);
    expect(reasonOf((await patch(`${HANDBOOK}<p><span data-sign-field="employee_signature"></span></p>`, FIELDS)).body)).toBe('field_marker_duplicate');
    const wide = `<table><tr>${'<td>x</td>'.repeat(7)}<td><span data-sign-field="employee_signature"></span></td></tr></table>`;
    expect(reasonOf((await patch(wide, [FIELDS[2]])).body)).toBe('field_too_wide');
    const noRoles = await call(operatorJwt, 'PATCH', `/platform/document-templates/versions/${draftId}`, {
      render_schema_version: 'rtr-html-v3',
      field_schema: { render_schema_version: 'rtr-html-v3', title: 'Employee Handbook', html: HANDBOOK, signing: null },
      fields: FIELDS,
    });
    expect(reasonOf(noRoles.body)).toBe('signing_roles_required');
    expect(await rowCount(draftId)).toBe(0);
  });

  it('the platform places three fields in the text: content and rows saved together, rows keep NULL geometry', async () => {
    const saved = await call(operatorJwt, 'PATCH', `/platform/document-templates/versions/${draftId}`, { render_schema_version: 'rtr-html-v3', field_schema: content(HANDBOOK), fields: FIELDS });
    expectStatus(saved, 200);
    expect((saved.body['field_schema'] as { html: string }).html).toBe(HANDBOOK);
    const listed = await call(operatorJwt, 'GET', `/platform/document-templates/versions/${draftId}/fields`);
    expectStatus(listed, 200);
    const rows = listed.body['fields'] as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r['field_key'], r['field_type'], r['signer_role'], r['page_number'], r['x']])).toEqual([
      ['employee_initials', 'INITIALS', 'employee', null, null],
      ['it_policy', 'CHECKBOX', 'employee', null, null],
      ['employee_signature', 'SIGNATURE', 'employee', null, null],
    ]);
  });

  it('the preview draws labelled boxes; publish succeeds; an ats template refuses publishing', async () => {
    const pv = await call(operatorJwt, 'POST', `/platform/document-templates/versions/${draftId}/preview`);
    expectStatus(pv, 200);
    expect(pv.body['html']).toContain('<span data-sign-field-sample="employee_signature">Signature · Employee</span>');
    expectStatus(await call(operatorJwt, 'POST', `/platform/document-templates/versions/${draftId}/publish`), 200);

    const ats = await call(operatorJwt, 'POST', '/platform/document-templates', { document_type_id: RTR, name: 'ATS handbook', template_kind: 'GENERATED', products: ['ats', 'sign'] });
    const atsDraft = await call(operatorJwt, 'POST', `/platform/document-templates/${ats.body['id'] as string}/versions`, { render_schema_version: 'rtr-html-v3', field_schema: content('<p>Draft</p>') });
    const atsId = atsDraft.body['id'] as string;
    expectStatus(await call(operatorJwt, 'PATCH', `/platform/document-templates/versions/${atsId}`, { render_schema_version: 'rtr-html-v3', field_schema: content(HANDBOOK), fields: FIELDS }), 200);
    expectStatus(await call(operatorJwt, 'POST', `/platform/document-templates/versions/${atsId}/preview`), 200);
    const refused = await call(operatorJwt, 'POST', `/platform/document-templates/versions/${atsId}/publish`);
    expectStatus(refused, 422);
    expect(reasonOf(refused.body)).toBe('inline_fields_not_supported_for_ats');
  });

  it('a company adopts it (rows copied), edits the wording, cannot remove or add a field, and approves it', async () => {
    const adopted = await call(tenantJwt, 'POST', '/v1/document-templates/adopt', { library_template_id: templateId });
    expectStatus(adopted, 201);
    copyId = (adopted.body['template'] as { id: string }).id;
    copyVersionId = (adopted.body['version'] as { id: string }).id;
    expect(await rowCount(copyVersionId)).toBe(3);

    const reworded = HANDBOOK.replace('I have read the Employee Handbook.', 'I confirm I have read the Acme Employee Handbook.');
    const edited = await call(tenantJwt, 'PATCH', `/v1/document-templates/versions/${copyVersionId}`, { render_schema_version: 'rtr-html-v3', field_schema: content(reworded) });
    expectStatus(edited, 200);
    const removed = await call(tenantJwt, 'PATCH', `/v1/document-templates/versions/${copyVersionId}`, {
      render_schema_version: 'rtr-html-v3',
      field_schema: content(reworded.replace('<span data-sign-field="it_policy"></span>', '')),
    });
    expectStatus(removed, 422);
    expect(reasonOf(removed.body)).toBe('fields_platform_only');
    const added = await call(tenantJwt, 'POST', `/v1/document-templates/versions/${copyVersionId}/fields`, { field_key: 'extra', field_type: 'TEXT', ordinal: 9 });
    expectStatus(added, 422);
    expect(reasonOf(added.body)).toBe('fields_platform_only');
    expect(await rowCount(copyVersionId)).toBe(3);

    expectStatus(await call(tenantJwt, 'POST', `/v1/document-templates/versions/${copyVersionId}/preview`), 200);
    expectStatus(await call(tenantJwt, 'POST', `/v1/document-templates/versions/${copyVersionId}/activate`), 200);
  });

  it('"Use" in Sign returns every field with its render position; the manifest records them; no block for the inline signer', async () => {
    const body = { values: {}, created_by: TENANT_ADMIN, client_id: null };
    const res = await s2sRender(copyId, body, 'tf1-use-0001');
    expectStatus(res, 201);
    const defs = res.body['field_definitions'] as Array<{ field_key: string; page_number: number | null; x: number | null; y: number | null; width: number | null }>;
    expect(defs.map((d) => d.field_key)).toEqual(['employee_initials', 'it_policy', 'employee_signature']);
    for (const d of defs) {
      expect(typeof d.page_number).toBe('number');
      expect(typeof d.x).toBe('number');
      expect(typeof d.y).toBe('number');
    }
    expect(defs.find((d) => d.field_key === 'employee_signature')?.width).toBe(230);
    expect((res.body['inline_fields'] as unknown[]).length).toBe(3);
    // R-4 — the employee signs inline: only the manager's block is appended.
    const sig = res.body['signature_fields'] as Array<{ role_key?: string }>;
    expect(new Set(sig.map((f) => f.role_key))).toEqual(new Set(['manager']));

    const rev = await db.query(`SELECT render_manifest FROM documents."DocumentRevision" WHERE id = $1`, [res.body['document_revision_ref']]);
    const manifest = rev.rows[0].render_manifest as { inline_fields: Array<{ field_key: string }> };
    expect(manifest.inline_fields.map((f) => f.field_key)).toEqual(['employee_initials', 'it_policy', 'employee_signature']);
    const pdf = [...objects.values()].find((b) => b.subarray(0, 4).toString() === '%PDF');
    expect(pdf).toBeDefined();
    expect((await PDFDocument.load(pdf as Buffer)).getPageCount()).toBeGreaterThanOrEqual(1);
    // Idempotent: the same key returns the same positions.
    const again = await s2sRender(copyId, body, 'tf1-use-0001');
    expect(again.body['inline_fields']).toEqual(res.body['inline_fields']);
  });
});
