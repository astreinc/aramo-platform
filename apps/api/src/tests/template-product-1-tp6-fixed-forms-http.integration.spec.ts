import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, resolveIdentityMigrations, resolveEntitlementMigrations } from '@aramo/common';
import { signEsignServiceRequest, signTemplateBodyDigest } from '@aramo/documents-contracts';
import { ObjectStorageService } from '@aramo/object-storage';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import express from 'express';
import { PDFDocument } from 'pdf-lib';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app.module.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7.4 — an Aramo fixed form in Aramo
// Sign through a booted AppModule on real Postgres 17, over the signed S2S channel:
//   - a published fixed form tagged `sign` is listed (template_kind FIXED_FORM, its roles and
//     the variables of its prefilled text fields); one the tenant hid is not, nor is one tagged
//     only `ats`;
//   - "Use" (render) freezes the stored official PDF — the prefilled organization value printed
//     on it — as a Document + FROZEN DocumentRevision pinned to the exact version, idempotent on
//     the key; only the signer fields go back to Sign (field_definitions, by role).
// (Adoption refused and the repository rules: libs/documents TP-6 integration spec.)
// Object storage is an in-memory store. Skipped unless ARAMO_RUN_INTEGRATION=1.
const ROOT = resolve(__dirname, '../../../..');
const ENTITLEMENT_MIGRATIONS = resolveEntitlementMigrations(ROOT);
function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
const SECRET = 'tp6-s2s-secret';
const TENANT = '01900000-0000-7000-8000-0000000006e1';
const SENDER = '00000000-0000-7000-8000-0000000006e2';
const I9 = '0d0c0000-0000-7000-8000-0000000006f1'; // FIXED_FORM, {sign}
const W4 = '0d0c0000-0000-7000-8000-0000000006f2'; // FIXED_FORM, {ats}
const PATH = '/v1/documents/esign/templates';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('TEMPLATE-PRODUCT-1 TP-6 fixed forms in Sign (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let module: TestingModule;
  let db: Client;
  let port = 0;
  let savedEnv: Partial<Record<string, string | undefined>> = {};
  let i9 = { template: '', version: '' };
  let w4 = { template: '', version: '' };
  let sourceSha = '';
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

  async function fixedType(id: string, key: string, products: string[]): Promise<void> {
    await db.query(
      `INSERT INTO documents."DocumentType" (id, tenant_id, key, name, description, scope, execution_mode_default, retention_class, system_defined, active, type_class, template_kind, products, category)
       VALUES ($1, NULL, $2, $3, NULL, 'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD', false, true, 'TEMPLATE', 'FIXED_FORM', $4::text[], 'Employment')`,
      [id, key, key.replace(/_/g, ' '), products],
    );
  }

  // A published PLATFORM fixed form: the asset is recorded while the version is DRAFT (the DB
  // trigger), then the version is activated and pinned (as the platform publish does).
  async function publishedForm(typeId: string, name: string, products: string[], pdf: Uint8Array): Promise<{ template: string; version: string }> {
    const template = randomUUID();
    const version = randomUUID();
    const asset = randomUUID();
    const sha = createHash('sha256').update(pdf).digest('hex');
    const key = `documents/platform/template-assets/${version}/${sha}.pdf`;
    objects.set(key, Buffer.from(pdf));
    await db.query(
      `INSERT INTO documents."DocumentTemplate" (id, tenant_id, owner_scope, document_type_id, client_id, name, template_kind, status, current_version_id, products, created_by, updated_at)
       VALUES ($1, NULL, 'PLATFORM', $2, NULL, $3, 'UPLOADED_PDF', 'DRAFT', NULL, $4::text[], $5, now())`,
      [template, typeId, name, products, SENDER],
    );
    const content = {
      render_schema_version: 'fixed-form-pdf-v1',
      title: name,
      pdf: { asset_id: asset, sha256: sha, byte_size: pdf.byteLength, page_count: 1, pages: [{ width: 612, height: 792 }] },
      signing: {
        roles: [
          { role_key: 'employee', label: 'Employee', kind: 'SIGNER', order: 1 },
          { role_key: 'employer', label: 'Employer', kind: 'SIGNER', order: 2 },
        ],
        routing_mode: 'SEQUENTIAL',
      },
    };
    await db.query(
      `INSERT INTO documents."TemplateVersion" (id, tenant_id, template_id, version_number, status, render_schema_version, field_schema, created_by)
       VALUES ($1, NULL, $2, 1, 'DRAFT', 'fixed-form-pdf-v1', $3::jsonb, $4)`,
      [version, template, JSON.stringify(content), SENDER],
    );
    await db.query(
      `INSERT INTO documents."PlatformTemplateAsset" (id, template_version_id, storage_key, mime, sha256, byte_size, page_count, created_by)
       VALUES ($1, $2, $3, 'application/pdf', $4, $5, 1, $6)`,
      [asset, version, key, sha, pdf.byteLength, SENDER],
    );
    const fields: Array<[string, string, string | null, string | null, number]> = [
      ['employee_sig', 'SIGNATURE', 'employee', null, 100],
      ['employee_date', 'SIGN_DATE', 'employee', null, 140],
      ['employer_sig', 'SIGNATURE', 'employer', null, 200],
      ['employer_name', 'TEXT', null, 'organization.name', 600],
    ];
    for (const [i, [field_key, field_type, role, binding, y]] of fields.entries()) {
      await db.query(
        `INSERT INTO documents."TemplateFieldDefinition" (id, template_version_id, field_key, field_type, binding_key, required, page_number, x, y, width, height, signer_role, ordinal)
         VALUES ($1, $2, $3, $4, $5, true, 0, 72, $6, 180, 24, $7, $8)`,
        [randomUUID(), version, field_key, field_type, binding, y, role, i],
      );
    }
    await db.query(`UPDATE documents."TemplateVersion" SET status = 'ACTIVE', activated_at = now(), activated_by = $2 WHERE id = $1`, [version, SENDER]);
    await db.query(`UPDATE documents."DocumentTemplate" SET status = 'ACTIVE', current_version_id = $2 WHERE id = $1`, [template, version]);
    sourceSha = sha;
    return { template, version };
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

    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const pdf = await doc.save({ useObjectStreams: false });
    await fixedType(I9, 'TP6_FORM_I9', ['sign']);
    await fixedType(W4, 'TP6_FORM_W4', ['ats']);
    w4 = await publishedForm(W4, 'Form W-4', ['ats'], pdf);
    i9 = await publishedForm(I9, 'Form I-9', ['sign'], pdf);

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

  it('lists the visible fixed form tagged sign — never the ats-only one, never a hidden one', async () => {
    const res = await call('GET', `${PATH}?tenant_id=${TENANT}`);
    expect(res.status).toBe(200);
    const items = res.body['items'] as Array<Record<string, unknown>>;
    expect(items.map((i) => i['template_id'])).toEqual([i9.template]);
    expect(items[0]).toMatchObject({
      template_kind: 'FIXED_FORM',
      owner_scope: 'PLATFORM',
      resolution: 'AVAILABLE',
      is_default: false,
      version_id: i9.version,
      signer_role_count: 2,
      routing_mode: 'SEQUENTIAL',
      document_type: { id: I9, key: 'TP6_FORM_I9' },
    });
    expect(items[0]?.['variables']).toEqual([{ key: 'organization.name', label: expect.any(String), group: expect.any(String), source: 'ORGANIZATION', value: 'Nimbus Leasing' }]);
    expect(items.some((i) => i['template_id'] === w4.template)).toBe(false);

    await db.query(
      `INSERT INTO documents."TenantTemplateVisibility" (tenant_id, template_id, hidden, updated_by, updated_at) VALUES ($1, $2, true, $3, now())`,
      [TENANT, i9.template, SENDER],
    );
    const hidden = await call('GET', `${PATH}?tenant_id=${TENANT}`);
    expect((hidden.body['items'] as unknown[]).length).toBe(0);
    expect((await post('preview', i9.template, { values: {} })).status).toBe(404);
    await db.query(`UPDATE documents."TenantTemplateVisibility" SET hidden = false WHERE tenant_id = $1 AND template_id = $2`, [TENANT, i9.template]);
  });

  it('preview gives the roles and variables, no html', async () => {
    const res = await post('preview', i9.template, { values: {} });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ template_id: i9.template, version_id: i9.version, html: null, blocks: [], template_kind: 'FIXED_FORM' });
    expect((res.body['signing'] as { roles: unknown[] }).roles).toHaveLength(2);
  });

  it('"Use" freezes the stored PDF (prefilled value printed) pinned to the exact version, idempotent on the key', async () => {
    const body = { values: {}, created_by: SENDER, client_id: null };
    const res = await post('render', i9.template, body, { idempotency_key: 'tp6-render-0001' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ template_id: i9.template, template_version_id: i9.version, signature_fields: [], template_kind: 'FIXED_FORM' });
    expect((res.body['field_definitions'] as Array<{ field_key: string; signer_role: string }>).map((f) => `${f.field_key}:${f.signer_role}`)).toEqual([
      'employee_sig:employee',
      'employee_date:employee',
      'employer_sig:employer',
    ]);
    const rev = await db.query(
      `SELECT r.status, r.template_version_id::text AS v, r.content_sha256, r.render_manifest, d.document_type_id::text AS t, d.execution_mode
         FROM documents."DocumentRevision" r JOIN documents."Document" d ON d.id = r.document_id WHERE r.id = $1`,
      [res.body['document_revision_ref']],
    );
    expect(rev.rows[0]).toMatchObject({ status: 'FROZEN', v: i9.version, t: I9, execution_mode: 'MULTI_SIGNATURE' });
    expect(rev.rows[0].render_manifest.fixed_form).toMatchObject({ template_id: i9.template, source_sha256: sourceSha, prefilled_keys: ['organization.name'] });
    // The frozen bytes are the official PDF with the value printed (not the untouched source).
    const frozen = [...objects.entries()].find(([k]) => k.startsWith(`documents/${TENANT}/`))?.[1];
    expect(frozen).toBeDefined();
    expect(createHash('sha256').update(frozen!).digest('hex')).toBe(rev.rows[0].content_sha256);
    expect(rev.rows[0].content_sha256).not.toBe(sourceSha);
    expect((await PDFDocument.load(frozen!)).getPageCount()).toBe(1);

    const again = await post('render', i9.template, body, { idempotency_key: 'tp6-render-0001' });
    expect(again.status).toBe(201);
    expect(again.body['document_revision_ref']).toBe(res.body['document_revision_ref']);
  });
});
