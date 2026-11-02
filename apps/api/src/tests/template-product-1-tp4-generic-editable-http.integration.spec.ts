import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, resolveIdentityMigrations, resolveEntitlementMigrations } from '@aramo/common';
import { TEMPLATE_CAPABILITIES, type TemplateCapabilitiesPort } from '@aramo/documents';
import { signEsignServiceRequest, signTemplateBodyDigest } from '@aramo/documents-contracts';
import { ObjectStorageService } from '@aramo/object-storage';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import express from 'express';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app.module.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §5 — the generic editable contract
// through a booted AppModule on real Postgres 17:
//   §5.1 configurability is DATA (a type created as EDITABLE is configurable; a type with no kind
//        or a FIXED_FORM is not);
//   §5.3 its variables are the catalog rows whose products intersect the type's;
//   §5.4 Aramo Sign lists, previews and renders a configured EDITABLE type tagged `sign` (a type
//        tagged only `ats`, or not configured, is never offered) through the shared RTR modules,
//        resolved per document type;
//   §5.6 ATS RTR is unchanged (its catalog result is the seeded 15 rows).
// Object storage is overridden with an in-memory store. Skipped unless ARAMO_RUN_INTEGRATION=1.
const ROOT = resolve(__dirname, '../../../..');
const ENTITLEMENT_MIGRATIONS = resolveEntitlementMigrations(ROOT);
function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
const SECRET = 'tp4-s2s-secret';
const TENANT = '01900000-0000-7000-8000-0000000004a1';
const SENDER = '00000000-0000-7000-8000-0000000004a2';
const RTR = 'd0c50005-0000-7000-8000-000000000001';
const NDA = '0d0c0000-0000-7000-8000-0000000004b1'; // EDITABLE, {sign}
const ATS_ONLY = '0d0c0000-0000-7000-8000-0000000004b2'; // EDITABLE, {ats}
const UNSET = '0d0c0000-0000-7000-8000-0000000004b3'; // kind NULL
const PATH = '/v1/documents/esign/templates';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('TEMPLATE-PRODUCT-1 TP-4 generic editable contract (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let module: TestingModule;
  let db: Client;
  let port = 0;
  let savedEnv: Partial<Record<string, string | undefined>> = {};
  let ndaTemplate = '';
  let ndaVersion = '';
  let atsTemplate = '';
  let unsetTemplate = '';
  const objects = new Map<string, Buffer>();

  const url = (p: string): string => `http://127.0.0.1:${port}${p}`;
  async function call(method: 'GET' | 'POST', pathAndQuery: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const full = url(pathAndQuery);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...signEsignServiceRequest({ method, url: full, secret: SECRET, nowSec: Math.floor(Date.now() / 1000) }),
    };
    const res = await fetch(full, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }
  function post(op: 'preview' | 'render', template: string, body: unknown, extra: Record<string, string> = {}) {
    const q = new URLSearchParams({ tenant_id: TENANT, body_sha256: signTemplateBodyDigest(body), ...extra });
    return call('POST', `${PATH}/${template}/${op}?${q.toString()}`, body);
  }

  async function documentType(id: string, key: string, kind: string | null, products: string[]): Promise<void> {
    await db.query(
      `INSERT INTO documents."DocumentType" (id, tenant_id, key, name, description, scope, execution_mode_default, retention_class, system_defined, active, type_class, template_kind, products, category)
       VALUES ($1, NULL, $2, $3, NULL, 'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD', false, true, 'TEMPLATE', $4, $5::text[], 'Legal')`,
      [id, key, key.replace(/_/g, ' '), kind, products],
    );
  }
  async function activeTemplate(typeId: string, name: string, html: string): Promise<{ id: string; version: string }> {
    const id = randomUUID();
    const version = randomUUID();
    await db.query(
      `INSERT INTO documents."DocumentTemplate" (id, tenant_id, owner_scope, document_type_id, client_id, name, template_kind, status, current_version_id, created_by, updated_at)
       VALUES ($1, $2, 'TENANT', $3, NULL, $4, 'GENERATED', 'ACTIVE', NULL, $5, now())`,
      [id, TENANT, typeId, name, SENDER],
    );
    await db.query(
      `INSERT INTO documents."TemplateVersion" (id, tenant_id, template_id, version_number, status, render_schema_version, field_schema, created_by, activated_at)
       VALUES ($1, $2, $3, 1, 'ACTIVE', 'rtr-html-v1', $4::jsonb, $5, now())`,
      [version, TENANT, id, JSON.stringify({ render_schema_version: 'rtr-html-v1', title: name, html, logo: null }), SENDER],
    );
    await db.query(`UPDATE documents."DocumentTemplate" SET current_version_id = $2 WHERE id = $1`, [id, version]);
    await db.query(
      `INSERT INTO documents."TenantTemplateSelection" (id, tenant_id, document_type_id, client_id, template_id, selected_by, selected_at) VALUES ($1, $2, $3, NULL, $4, $5, now())`,
      [randomUUID(), TENANT, typeId, id, SENDER],
    );
    return { id, version };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const dburl = container.getConnectionUri();
    db = new Client({ connectionString: dburl });
    await db.connect();
    for (const p of resolveIdentityMigrations(ROOT)) await db.query(readFileSync(p, 'utf8'));
    for (const p of ENTITLEMENT_MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
    for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));
    await ensureWriteFreezeTenant((s) => db.query(s), TENANT);
    await db.query(`UPDATE identity."Tenant" SET display_name = 'Nimbus Leasing' WHERE id = $1`, [TENANT]);

    await documentType(NDA, 'TP4_MUTUAL_NDA', 'EDITABLE', ['sign']);
    await documentType(ATS_ONLY, 'TP4_ATS_LETTER', 'EDITABLE', ['ats']);
    await documentType(UNSET, 'TP4_UNCONFIGURED', null, []);
    const nda = await activeTemplate(NDA, 'Nimbus NDA', '<p>Between <span data-field="organization.name"></span> and the recipient.</p>');
    ndaTemplate = nda.id;
    ndaVersion = nda.version;
    atsTemplate = (await activeTemplate(ATS_ONLY, 'Nimbus ATS letter', '<p>From <span data-field="organization.name"></span>.</p>')).id;
    unsetTemplate = (await activeTemplate(UNSET, 'Nimbus unconfigured', '<p>From <span data-field="organization.name"></span>.</p>')).id;

    savedEnv = { DATABASE_URL: process.env['DATABASE_URL'], ARAMO_ENV: process.env['ARAMO_ENV'], SIGN_WEBHOOK_SIGNING_SECRET: process.env['SIGN_WEBHOOK_SIGNING_SECRET'], SIGN_S2S_AUTH_MODE: process.env['SIGN_S2S_AUTH_MODE'] };
    process.env['DATABASE_URL'] = dburl;
    process.env['ARAMO_ENV'] = 'itest';
    process.env['SIGN_WEBHOOK_SIGNING_SECRET'] = SECRET;
    delete process.env['SIGN_S2S_AUTH_MODE'];
    const storage = {
      putObjectBytes: async (i: { storage_key: string; body: Buffer }) => {
        objects.set(i.storage_key, i.body);
        return { storage_ref: i.storage_key, sha256: createHash('sha256').update(i.body).digest('hex') };
      },
      getObjectBytes: async (i: { storage_key: string }) => objects.get(i.storage_key) ?? Buffer.alloc(0),
    };
    module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(ObjectStorageService).useValue(storage).compile();
    app = module.createNestApplication({ bodyParser: false });
    (app.getHttpAdapter().getInstance() as ReturnType<typeof express>).use(express.json());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    const server = await app.listen(0);
    port = (server.address() as AddressInfo).port;
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

  it('§5.1 configurability is data: EDITABLE types are configurable; RTR stays; unconfigured is not', async () => {
    const caps = module.get<TemplateCapabilitiesPort>(TEMPLATE_CAPABILITIES);
    expect(await caps.isConfigurable(RTR)).toBe(true);
    expect(await caps.isConfigurable(NDA)).toBe(true);
    expect(await caps.isConfigurable(ATS_ONLY)).toBe(true);
    expect(await caps.isConfigurable(UNSET)).toBe(false);
    await db.query(`UPDATE documents."DocumentType" SET template_kind = 'FIXED_FORM' WHERE id = $1`, [UNSET]);
    expect(await caps.isConfigurable(UNSET)).toBe(false);
    await db.query(`UPDATE documents."DocumentType" SET template_kind = NULL WHERE id = $1`, [UNSET]);
  });

  it('§5.3 variables = catalog rows whose products intersect the type; RTR keeps its 15', async () => {
    const caps = module.get<TemplateCapabilitiesPort>(TEMPLATE_CAPABILITIES);
    expect((await caps.listAllowedBindings(RTR)).map((b) => b.key)).toHaveLength(15);
    expect((await caps.listAllowedBindings(ATS_ONLY)).map((b) => b.key)).toHaveLength(15);
    const nda = (await caps.listAllowedBindings(NDA)).map((b) => b.key);
    expect(nda).toHaveLength(7);
    expect(nda.every((k) => k.startsWith('organization.'))).toBe(true);
    expect(await caps.listAllowedBindings(UNSET)).toEqual([]);
  });

  it('§5.4 Sign lists the configured editable type tagged sign — never the ats-only or unconfigured one', async () => {
    const res = await call('GET', `${PATH}?tenant_id=${TENANT}`);
    expect(res.status).toBe(200);
    const items = res.body['items'] as Array<Record<string, unknown>>;
    expect(items.map((i) => i['template_id'])).toEqual([ndaTemplate]);
    expect(items[0]).toMatchObject({
      is_default: true,
      resolution: 'TENANT_SELECTION',
      version_id: ndaVersion,
      document_type: { id: NDA, key: 'TP4_MUTUAL_NDA' },
    });
    expect((items[0]?.['variables'] as Array<{ key: string; source: string; value: string | null }>)[0]).toMatchObject({
      key: 'organization.name',
      source: 'ORGANIZATION',
      value: 'Nimbus Leasing',
    });
    expect(items.some((i) => i['template_id'] === atsTemplate || i['template_id'] === unsetTemplate)).toBe(false);
  });

  it('§5.4 preview and render a new editable type; an ats-only type is not renderable in Sign', async () => {
    const preview = await post('preview', ndaTemplate, { values: {} });
    expect(preview.status).toBe(200);
    expect(String(preview.body['html'])).toContain('Nimbus Leasing');

    // A single-signer template (no SIGNER roles) always binds the printed signer name
    // talent.full_name (M-A6 §3.3, RtrTemplateBindingService.usedKeys) — a SENDER value. Without
    // it the render refuses (422) before any write; with it the new type renders.
    const unfilled = await post('render', ndaTemplate, { values: {}, created_by: SENDER, client_id: null }, { idempotency_key: 'tp4-render-0000' });
    expect(unfilled.status).toBe(422);
    expect(unfilled.body['error']).toMatchObject({ code: 'RTR_TEMPLATE_BINDING_MISSING', details: { missing_keys: ['talent.full_name'] } });

    const render = await post('render', ndaTemplate, { values: { 'talent.full_name': 'Jordan Signer' }, created_by: SENDER, client_id: null }, { idempotency_key: 'tp4-render-0001' });
    expect(render.status).toBe(201);
    expect(render.body).toMatchObject({ template_id: ndaTemplate, template_version_id: ndaVersion });
    const doc = await db.query(`SELECT document_type_id::text, execution_mode FROM documents."Document" WHERE id = $1`, [render.body['document_id']]);
    expect(doc.rows[0]).toEqual({ document_type_id: NDA, execution_mode: 'SINGLE_SIGNATURE' });

    const ats = await post('preview', atsTemplate, { values: {} });
    expect(ats.status).toBe(404);
    expect((ats.body['error'] as { details?: { reason?: string } }).details?.reason).toBe('document_type_not_renderable');
  });
});
