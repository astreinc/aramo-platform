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
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app.module.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';
import { grantLegacyPlatformSelection } from './helpers/legacy-template-selection.js';

// DOC-TEMPLATE-LIB-1 T-5 — Implementation Directive v1.0 (LOCKED) §7.1 (ADR-0034 D6, D8,
// D12; Conforming Amendment #9): the signed Documents template-library endpoints Aramo Sign
// calls, through a booted AppModule on real Postgres 17. Proves:
//   - S2S authentication: unsigned / forged / skewed / re-targeted requests and a body that
//     does not match its signed digest are refused (401); a missing secret fails closed (503);
//   - list = the template each tenant's explicit choice resolves to (Aramo default, or the
//     tenant's own selection), with SENDER / ORGANIZATION variables; tenants never see each
//     other's templates (cross-tenant render = 404);
//   - preview writes nothing;
//   - render freezes a Document + DocumentRevision PINNED to the exact template version,
//     with the tenant's branding bound into an Aramo default; it is idempotent on its key
//     (same key + body ⇒ same revision; same key + other body ⇒ 409); a missing sender
//     value / an organization value from the sender is refused before any write.
// Object storage is external infra (overridden with an in-memory store). Skipped unless
// ARAMO_RUN_INTEGRATION=1.
const ROOT = resolve(__dirname, '../../../..');
// CCP-A7 — the full entitlement set (the shared helper; the repository reads A7 columns).
const ENTITLEMENT_MIGRATIONS = resolveEntitlementMigrations(ROOT);
function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
const SECRET = 'doclib-t5-s2s-secret';
const TENANT_A = '01900000-0000-7000-8000-0000000000f5';
const TENANT_B = '01900000-0000-7000-8000-0000000000f6';
// Amendment M-A6 §3.1–§3.3 — a tenant with several ACTIVE templates (one with roles).
const TENANT_C = '01900000-0000-7000-8000-0000000000f7';
const SENDER_C = '00000000-0000-7000-8000-00000000f7c1';
const ROLES_SIGNING = {
  roles: [
    { role_key: 'client', label: 'Client', kind: 'SIGNER', order: 1 },
    { role_key: 'agency', label: 'Agency', kind: 'SIGNER', order: 2 },
    { role_key: 'hr_copy', label: 'HR copy', kind: 'CC', order: 3 },
  ],
  routing_mode: 'SEQUENTIAL',
  default_subject: 'Please sign the agreement',
};
const SENDER_A = '00000000-0000-7000-8000-00000000f5a1';
const SENDER_B = '00000000-0000-7000-8000-00000000f6b1';
const RTR = 'd0c50005-0000-7000-8000-000000000001';
const PATH = '/v1/documents/esign/templates';

interface Res {
  status: number;
  body: Record<string, unknown>;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('DOC-TEMPLATE-LIB-1 T-5 Sign template library — signed S2S HTTP (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let module: TestingModule;
  let db: Client;
  let port = 0;
  let savedEnv: Partial<Record<string, string | undefined>> = {};
  let defaultId = '';
  let brandedVersionId = '';
  let ownB = '';
  let ownBVersion = '';
  let plainC = '';
  let rolesC = '';
  let rolesCVersion = '';
  let draftC = '';
  const objects = new Map<string, Buffer>();

  const url = (p: string): string => `http://127.0.0.1:${port}${p}`;
  const errorCode = (b: Record<string, unknown>): unknown => (b['error'] as { code?: unknown } | undefined)?.code;

  async function call(method: 'GET' | 'POST', pathAndQuery: string, opts: { body?: unknown; sign?: boolean; secret?: string; nowSec?: number; signAs?: string } = {}): Promise<Res> {
    const full = url(pathAndQuery);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.sign !== false) {
      Object.assign(
        headers,
        signEsignServiceRequest({ method, url: opts.signAs !== undefined ? url(opts.signAs) : full, secret: opts.secret ?? SECRET, nowSec: opts.nowSec ?? Math.floor(Date.now() / 1000) }),
      );
    }
    const res = await fetch(full, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
    const text = await res.text();
    return { status: res.status, body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }
  const list = (tenant: string, opts: Parameters<typeof call>[2] = {}) => call('GET', `${PATH}?tenant_id=${tenant}`, opts);
  function post(op: 'preview' | 'render', tenant: string, template: string, body: unknown, extra: Record<string, string> = {}, opts: Parameters<typeof call>[2] = {}) {
    const q = new URLSearchParams({ tenant_id: tenant, body_sha256: signTemplateBodyDigest(body), ...extra });
    return call('POST', `${PATH}/${template}/${op}?${q.toString()}`, { body, ...opts });
  }
  const docCount = async (tenant?: string): Promise<number> =>
    (await db.query(`SELECT count(*)::int AS n FROM documents."Document"${tenant !== undefined ? ' WHERE tenant_id = $1' : ''}`, tenant !== undefined ? [tenant] : [])).rows[0].n;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const dburl = container.getConnectionUri();
    db = new Client({ connectionString: dburl });
    await db.connect();
    for (const p of resolveIdentityMigrations(ROOT)) await db.query(readFileSync(p, 'utf8'));
    for (const entitlementMigration of ENTITLEMENT_MIGRATIONS) await db.query(readFileSync(entitlementMigration, 'utf8'));
    for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));
    for (const t of [TENANT_A, TENANT_B, TENANT_C]) await ensureWriteFreezeTenant((s) => db.query(s), t);
    await db.query(`UPDATE identity."Tenant" SET display_name = 'Acme Branded Staffing', legal_name = 'Acme Staffing LLC', city = 'Springfield' WHERE id = $1`, [TENANT_A]);

    const def = await db.query(`SELECT id::text FROM documents."DocumentTemplate" WHERE owner_scope = 'PLATFORM' AND document_type_id = $1`, [RTR]);
    expect(def.rows).toHaveLength(1);
    defaultId = def.rows[0].id;
    // A new ACTIVE version of the Aramo default that binds the tenant's organization name
    // (so branding is observable in the frozen render) — the current version moves to it.
    brandedVersionId = randomUUID();
    await db.query(
      `INSERT INTO documents."TemplateVersion" (id, tenant_id, template_id, version_number, status, render_schema_version, field_schema, created_by, activated_at)
       VALUES ($1, NULL, $2, 90, 'ACTIVE', 'rtr-generated-v1', $3::jsonb, $4, now())`,
      [
        brandedVersionId,
        defaultId,
        JSON.stringify({
          render_schema_version: 'rtr-generated-v1',
          title: 'Right to Represent',
          blocks: [
            { type: 'HEADING', text: 'Right to Represent' },
            { type: 'TEXT', text: '{{organization.name}} is authorized to represent {{talent.full_name}} for {{requisition.title}}.' },
          ],
        }),
        SENDER_A,
      ],
    );
    await db.query(`UPDATE documents."DocumentTemplate" SET current_version_id = $2 WHERE id = $1`, [defaultId, brandedVersionId]);
    // ORG-UX-1 §5.3 (T-A) — tenant A is on the Aramo default through a grandfathered selection.
    await grantLegacyPlatformSelection((q, p) => db.query(q, p), { tenant_id: TENANT_A, document_type_id: RTR, template_id: defaultId });

    // Tenant B has its own approved RTR template and selects it.
    ownB = randomUUID();
    ownBVersion = randomUUID();
    await db.query(
      `INSERT INTO documents."DocumentTemplate" (id, tenant_id, owner_scope, document_type_id, client_id, name, template_kind, status, current_version_id, created_by, updated_at)
       VALUES ($1, $2, 'TENANT', $3, NULL, 'Beta RTR', 'GENERATED', 'ACTIVE', NULL, $4, now())`,
      [ownB, TENANT_B, RTR, SENDER_B],
    );
    await db.query(
      `INSERT INTO documents."TemplateVersion" (id, tenant_id, template_id, version_number, status, render_schema_version, field_schema, created_by, activated_at)
       VALUES ($1, $2, $3, 1, 'ACTIVE', 'rtr-generated-v1', $4::jsonb, $5, now())`,
      [ownBVersion, TENANT_B, ownB, JSON.stringify({ render_schema_version: 'rtr-generated-v1', title: 'Beta RTR', blocks: [{ type: 'TEXT', text: 'Beta represents {{talent.full_name}}.' }] }), SENDER_B],
    );
    await db.query(`UPDATE documents."DocumentTemplate" SET current_version_id = $2 WHERE id = $1`, [ownB, ownBVersion]);
    await db.query(
      `INSERT INTO documents."TenantTemplateSelection" (id, tenant_id, document_type_id, client_id, template_id, selected_by, selected_at) VALUES ($1, $2, $3, NULL, $4, $5, now())`,
      [randomUUID(), TENANT_B, RTR, ownB, SENDER_B],
    );

    // Tenant C (M-A6): a selected plain template, an ACTIVE template with signing roles,
    // and a DRAFT template — the DRAFT is never offered.
    async function tenantTemplate(name: string, status: 'ACTIVE' | 'DRAFT', fieldSchema: unknown, renderSchema: string): Promise<{ id: string; version: string }> {
      const id = randomUUID();
      const version = randomUUID();
      await db.query(
        `INSERT INTO documents."DocumentTemplate" (id, tenant_id, owner_scope, document_type_id, client_id, name, description, template_kind, status, current_version_id, created_by, updated_at)
         VALUES ($1, $2, 'TENANT', $3, NULL, $4, $5, 'GENERATED', $6, NULL, $7, now())`,
        [id, TENANT_C, RTR, name, `${name} description`, status, SENDER_C],
      );
      await db.query(
        `INSERT INTO documents."TemplateVersion" (id, tenant_id, template_id, version_number, status, render_schema_version, field_schema, created_by, activated_at)
         VALUES ($1, $2, $3, 1, $4, $5, $6::jsonb, $7, ${status === 'ACTIVE' ? 'now()' : 'NULL'})`,
        [version, TENANT_C, id, status, renderSchema, JSON.stringify(fieldSchema), SENDER_C],
      );
      if (status === 'ACTIVE') await db.query(`UPDATE documents."DocumentTemplate" SET current_version_id = $2 WHERE id = $1`, [id, version]);
      return { id, version };
    }
    plainC = (await tenantTemplate('Gamma RTR', 'ACTIVE', { render_schema_version: 'rtr-generated-v1', title: 'Gamma RTR', blocks: [{ type: 'TEXT', text: 'Gamma represents {{talent.full_name}}.' }] }, 'rtr-generated-v1')).id;
    const roles = await tenantTemplate(
      'Gamma Mutual Agreement',
      'ACTIVE',
      { render_schema_version: 'rtr-html-v1', title: 'Mutual Agreement', html: '<p>Agreement for <span data-field="requisition.title"></span>.</p>', logo: null, signing: ROLES_SIGNING },
      'rtr-html-v1',
    );
    rolesC = roles.id;
    rolesCVersion = roles.version;
    draftC = (await tenantTemplate('Gamma Draft', 'DRAFT', { render_schema_version: 'rtr-generated-v1', title: 'Draft', blocks: [{ type: 'TEXT', text: 'Draft.' }] }, 'rtr-generated-v1')).id;
    await db.query(
      `INSERT INTO documents."TenantTemplateSelection" (id, tenant_id, document_type_id, client_id, template_id, selected_by, selected_at) VALUES ($1, $2, $3, NULL, $4, $5, now())`,
      [randomUUID(), TENANT_C, RTR, plainC, SENDER_C],
    );

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

  it('S2S authentication — unsigned, forged, skewed and re-targeted requests are refused (401)', async () => {
    expect((await list(TENANT_A, { sign: false })).status).toBe(401);
    expect((await list(TENANT_A, { secret: 'not-the-secret' })).status).toBe(401);
    expect((await list(TENANT_A, { nowSec: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    // Signed for tenant A, sent for tenant B: the query is bound by the signature.
    const retargeted = await list(TENANT_B, { signAs: `${PATH}?tenant_id=${TENANT_A}` });
    expect(retargeted.status).toBe(401);
    expect(errorCode(retargeted.body)).toBe('AUTH_REQUIRED');
  });

  it('S2S authentication — a body that does not match its signed digest is refused; nothing is written', async () => {
    const signedFor = { values: { 'talent.full_name': 'Jordan Signer', 'requisition.title': 'Analyst' }, created_by: SENDER_A, client_id: null };
    const tampered = { ...signedFor, values: { ...signedFor.values, 'talent.full_name': 'Mallory' } };
    const q = new URLSearchParams({ tenant_id: TENANT_A, idempotency_key: 'tamper-0001', body_sha256: signTemplateBodyDigest(signedFor) });
    const res = await call('POST', `${PATH}/${defaultId}/render?${q.toString()}`, { body: tampered });
    expect(res.status).toBe(401);
    expect(await docCount()).toBe(0);
  });

  it('list — each tenant gets the template its choice resolves to, with SENDER / ORGANIZATION variables', async () => {
    const a = await list(TENANT_A);
    expect(a.status).toBe(200);
    const items = a.body['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ template_id: defaultId, owner_scope: 'PLATFORM', resolution: 'TENANT_SELECTION', version_id: brandedVersionId, version_number: 90 });
    const vars = items[0]?.['variables'] as Array<{ key: string; source: string; value: string | null }>;
    expect(vars.find((v) => v.key === 'organization.name')).toMatchObject({ source: 'ORGANIZATION', value: 'Acme Branded Staffing' });
    expect(vars.find((v) => v.key === 'talent.full_name')).toMatchObject({ source: 'SENDER', value: null });
    expect(vars.find((v) => v.key === 'requisition.title')).toMatchObject({ source: 'SENDER' });

    const b = await list(TENANT_B);
    const bItems = b.body['items'] as Array<Record<string, unknown>>;
    expect(bItems).toHaveLength(1);
    expect(bItems[0]).toMatchObject({ template_id: ownB, owner_scope: 'TENANT', resolution: 'TENANT_SELECTION', version_id: ownBVersion });
  });

  it('preview — branded, with the sender values; writes nothing', async () => {
    const res = await post('preview', TENANT_A, defaultId, { values: { 'talent.full_name': 'Jordan Signer' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ template_id: defaultId, version_id: brandedVersionId, letterhead: { organization_name: 'Acme Branded Staffing', logo_available: false } });
    const text = JSON.stringify(res.body['blocks']);
    expect(text).toContain('Acme Branded Staffing');
    expect(text).toContain('Jordan Signer');
    expect(await docCount()).toBe(0);
  });

  it('cross-tenant — a template of another tenant (or not the tenant’s choice) is not found; nothing written', async () => {
    const body = { values: { 'talent.full_name': 'Jordan Signer' }, created_by: SENDER_A, client_id: null };
    const res = await post('render', TENANT_A, ownB, body, { idempotency_key: 'cross-0001' });
    expect(res.status).toBe(404);
    expect(errorCode(res.body)).toBe('TEMPLATE_NOT_FOUND');
    // Tenant B selected its own template: the Aramo default is not its choice.
    expect((await post('preview', TENANT_B, defaultId, { values: {} })).status).toBe(404);
    expect(await docCount()).toBe(0);
  });

  it('render — refuses a missing sender value and an organization value from the sender BEFORE any write', async () => {
    const missing = await post('render', TENANT_A, defaultId, { values: { 'talent.full_name': 'Jordan Signer' }, created_by: SENDER_A, client_id: null }, { idempotency_key: 'missing-0001' });
    expect(missing.status).toBe(422);
    expect(errorCode(missing.body)).toBe('RTR_TEMPLATE_BINDING_MISSING');
    expect((missing.body['error'] as { details: { missing_keys: string[] } }).details.missing_keys).toEqual(['requisition.title']);
    const org = await post(
      'render',
      TENANT_A,
      defaultId,
      { values: { 'talent.full_name': 'J', 'requisition.title': 'A', 'organization.name': 'Spoofed Co' }, created_by: SENDER_A, client_id: null },
      { idempotency_key: 'org-0001' },
    );
    expect(org.status).toBe(422);
    expect((org.body['error'] as { details: { reason: string } }).details.reason).toBe('variable_not_sender_fillable');
    expect(await docCount()).toBe(0);
  });

  it('render — freezes a Document + revision pinned to the exact version with the tenant branding; idempotent on the key', async () => {
    const body = { values: { 'talent.full_name': 'Jordan Signer', 'requisition.title': 'Business Analyst' }, created_by: SENDER_A, client_id: null };
    const res = await post('render', TENANT_A, defaultId, body, { idempotency_key: 'render-0001' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ template_id: defaultId, template_version_id: brandedVersionId, version_number: 90, title: 'Right to Represent' });
    const revId = res.body['document_revision_ref'] as string;
    const rev = await db.query(`SELECT tenant_id::text, template_version_id::text, status, content_sha256, render_manifest::text AS manifest FROM documents."DocumentRevision" WHERE id = $1`, [revId]);
    expect(rev.rows[0]).toMatchObject({ tenant_id: TENANT_A, template_version_id: brandedVersionId, status: 'FROZEN', content_sha256: res.body['source_sha256'] });
    expect(rev.rows[0].manifest).toContain('Acme Branded Staffing is authorized to represent Jordan Signer for Business Analyst.');
    const doc = await db.query(`SELECT tenant_id::text, document_type_id::text, source_kind, created_by::text FROM documents."Document" WHERE id = $1`, [res.body['document_id']]);
    expect(doc.rows[0]).toEqual({ tenant_id: TENANT_A, document_type_id: RTR, source_kind: 'TEMPLATE_GENERATED', created_by: SENDER_A });
    expect((res.body['signature_fields'] as unknown[]).length).toBeGreaterThan(0);
    expect(objects.size).toBe(1);

    // Same key + same body ⇒ the SAME revision, no second Document.
    const again = await post('render', TENANT_A, defaultId, body, { idempotency_key: 'render-0001' });
    expect(again.status).toBe(201);
    expect(again.body['document_revision_ref']).toBe(revId);
    expect(await docCount(TENANT_A)).toBe(1);
    // Same key + another body ⇒ 409.
    const conflict = await post('render', TENANT_A, defaultId, { ...body, values: { ...body.values, 'talent.full_name': 'Someone Else' } }, { idempotency_key: 'render-0001' });
    expect(conflict.status).toBe(409);
    expect(errorCode(conflict.body)).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(await docCount(TENANT_A)).toBe(1);
    // Tenant B never sees tenant A's Document.
    expect(await docCount(TENANT_B)).toBe(0);
  });

  // ── Amendment M-A6 §3.1–§3.3, §3.7 ─────────────────────────────────────────────
  it('M-A6 list — every ACTIVE template the tenant may use; the automatic choice is flagged; DRAFTs and other tenants\' templates never appear', async () => {
    const c = await list(TENANT_C);
    expect(c.status).toBe(200);
    const items = c.body['items'] as Array<Record<string, unknown>>;
    expect(items.map((i) => i['template_id']).sort()).toEqual([plainC, rolesC].sort());
    expect(items.some((i) => i['template_id'] === draftC || i['template_id'] === ownB || i['template_id'] === defaultId)).toBe(false);
    const plain = items.find((i) => i['template_id'] === plainC) as Record<string, unknown>;
    const roles = items.find((i) => i['template_id'] === rolesC) as Record<string, unknown>;
    expect(plain).toMatchObject({ is_default: true, resolution: 'TENANT_SELECTION', signer_role_count: 1, cc_role_count: 0, document_count: 1, routing_mode: 'PARALLEL', signing: null });
    expect(roles).toMatchObject({
      is_default: false,
      resolution: 'AVAILABLE',
      description: 'Gamma Mutual Agreement description',
      category: (roles['document_type'] as { name: string }).name,
      signer_role_count: 2,
      cc_role_count: 1,
      document_count: 1,
      routing_mode: 'SEQUENTIAL',
      version_id: rolesCVersion,
    });
    expect((roles['signing'] as { roles: Array<{ role_key: string }> }).roles.map((r) => r.role_key)).toEqual(['client', 'agency', 'hr_copy']);
    // The printed name is Sign-filled for a template with roles: no talent.full_name variable.
    expect((roles['variables'] as Array<{ key: string }>).map((v) => v.key)).toEqual(['requisition.title']);
    // Tenants A and B are unchanged (one template each).
    expect(((await list(TENANT_A)).body['items'] as unknown[]).length).toBe(1);
    expect(((await list(TENANT_B)).body['items'] as unknown[]).length).toBe(1);
  });

  it('M-A6 preview — a non-default usable template previews with its roles; another tenant cannot', async () => {
    const res = await post('preview', TENANT_C, rolesC, { values: { 'requisition.title': 'Analyst' } });
    expect(res.status).toBe(200);
    expect((res.body['signing'] as { routing_mode: string }).routing_mode).toBe('SEQUENTIAL');
    const plain = await post('preview', TENANT_C, plainC, { values: {} });
    expect(plain.body['signing']).toBeNull();
    expect((await post('preview', TENANT_A, rolesC, { values: {} })).status).toBe(404);
    expect((await post('preview', TENANT_C, draftC, { values: {} })).status).toBe(404);
  });

  it('M-A6 render — one block per SIGNER role (SIGNATURE / SIGNER_NAME / SIGN_DATE with role_key), MULTI_SIGNATURE', async () => {
    const before = await docCount(TENANT_C);
    const res = await post('render', TENANT_C, rolesC, { values: { 'requisition.title': 'Analyst' }, created_by: SENDER_C, client_id: null }, { idempotency_key: 'roles-0001' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ template_id: rolesC, template_version_id: rolesCVersion });
    const fields = res.body['signature_fields'] as Array<{ field_type: string; role_key?: string }>;
    expect(fields.map((f) => `${f.role_key}:${f.field_type}`)).toEqual([
      'client:SIGNATURE',
      'client:SIGNER_NAME',
      'client:SIGN_DATE',
      'agency:SIGNATURE',
      'agency:SIGNER_NAME',
      'agency:SIGN_DATE',
    ]);
    expect((res.body['signing'] as { roles: unknown[] }).roles).toHaveLength(3);
    const doc = await db.query(`SELECT execution_mode FROM documents."Document" WHERE id = $1`, [res.body['document_id']]);
    expect(doc.rows[0].execution_mode).toBe('MULTI_SIGNATURE');
    expect(await docCount(TENANT_C)).toBe(before + 1);
    // Another tenant can never render it.
    expect((await post('render', TENANT_A, rolesC, { values: { 'requisition.title': 'A' }, created_by: SENDER_A, client_id: null }, { idempotency_key: 'roles-x-0001' })).status).toBe(404);
  });

  it('M-A6 render — a template without roles keeps the single block (no role_key, SIGNATURE + SIGN_DATE), SINGLE_SIGNATURE', async () => {
    const res = await post('render', TENANT_C, plainC, { values: { 'talent.full_name': 'Jordan Signer' }, created_by: SENDER_C, client_id: null }, { idempotency_key: 'plain-0001' });
    expect(res.status).toBe(201);
    const fields = res.body['signature_fields'] as Array<Record<string, unknown>>;
    expect(fields.map((f) => f['field_type'])).toEqual(['SIGNATURE', 'SIGN_DATE']);
    expect(fields.every((f) => !('role_key' in f))).toBe(true);
    expect(res.body['signing']).toBeNull();
    const doc = await db.query(`SELECT execution_mode FROM documents."Document" WHERE id = $1`, [res.body['document_id']]);
    expect(doc.rows[0].execution_mode).toBe('SINGLE_SIGNATURE');
  });

  it('a missing signing secret fails closed (503)', async () => {
    delete process.env['SIGN_WEBHOOK_SIGNING_SECRET'];
    try {
      const res = await list(TENANT_A);
      expect(res.status).toBe(503);
      expect(errorCode(res.body)).toBe('ESIGN_SERVICE_AUTH_UNAVAILABLE');
    } finally {
      process.env['SIGN_WEBHOOK_SIGNING_SECRET'] = SECRET;
    }
  });
});
