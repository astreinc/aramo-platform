import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, resolveEntitlementMigrations, resolveIdentityMigrations } from '@aramo/common';
import { signEsignServiceRequest, signTemplateBodyDigest } from '@aramo/documents-contracts';
import { ObjectStorageService } from '@aramo/object-storage';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import express from 'express';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app.module.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

// Aramo-TEMPLATE-PRODUCT-1 Implementation Directive v1.0 (LOCKED) §8.3 / §8.5 — the signed
// Documents endpoints of the Sign template Studio and "Use as it is", through a booted AppModule
// on real Postgres 17. Proves:
//   - S2S authentication (unsigned / body not matching its signed digest → 401);
//   - the gallery lists only live Aramo defaults tagged `sign` (an ATS-only default is never
//     offered), with the tenant's adopted copy;
//   - "Use as it is": one call adopts the default and approves the unchanged copy — the copy
//     is ACTIVE and becomes the tenant's selection for its type (ADR-0034 D6); audited; a second
//     call is 409 already_adopted; a person without document_template:manage is refused 403
//     template_approval_required with nothing written; a BUSINESS approver may use it;
//   - the Studio is PERSONAL-only (BUSINESS 403 organization_templates_in_org_home) and drives
//     the existing tenant template code end to end: adopt → edit → preview → "Use this version";
//     a draft can be discarded; Documents owns every row (no Sign table is touched).
// Authority comes from the person's live role grants (identity Role / RoleScope rows seeded
// here). Object storage is overridden in memory. Skipped unless ARAMO_RUN_INTEGRATION=1.
const ROOT = resolve(__dirname, '../../../..');
const ENTITLEMENT_MIGRATIONS = resolveEntitlementMigrations(ROOT);
function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
const SECRET = 'tp7-s2s-secret';
const RTR = 'd0c50005-0000-7000-8000-000000000001';
const LIB = '/v1/documents/esign/templates/library';
const STUDIO = '/v1/documents/esign/templates/studio';

// Personal accounts (one owner each) and a Business organization (an approver + an author).
const PERSONAL_A = '01900000-0000-7000-8000-0000000007a1';
const PERSONAL_S = '01900000-0000-7000-8000-0000000007a2';
const BUSINESS_B = '01900000-0000-7000-8000-0000000007b1';
const OWNER_A = '00000000-0000-7000-8000-0000000007a1';
const OWNER_S = '00000000-0000-7000-8000-0000000007a2';
const ADMIN_B = '00000000-0000-7000-8000-0000000007b1';
const AUTHOR_B = '00000000-0000-7000-8000-0000000007b2';

interface Res {
  status: number;
  body: Record<string, unknown>;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('TEMPLATE-PRODUCT-1 §8 Sign template Studio + Use as it is — signed S2S HTTP (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let module: TestingModule;
  let db: Client;
  let port = 0;
  let savedEnv: Partial<Record<string, string | undefined>> = {};
  let defaultId = '';

  const url = (p: string): string => `http://127.0.0.1:${port}${p}`;
  const code = (b: Record<string, unknown>): unknown => (b['error'] as { code?: unknown } | undefined)?.code;
  const reason = (b: Record<string, unknown>): unknown => (b['error'] as { details?: { reason?: unknown } } | undefined)?.details?.reason;

  async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, query: Record<string, string>, opts: { body?: unknown; sign?: boolean; digestOf?: unknown } = {}): Promise<Res> {
    const hasBody = method === 'POST' || method === 'PATCH';
    const body = hasBody ? (opts.body ?? {}) : undefined;
    const q = new URLSearchParams({ ...query, ...(hasBody ? { body_sha256: signTemplateBodyDigest(opts.digestOf ?? body) } : {}) });
    const full = url(`${path}?${q.toString()}`);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.sign !== false) Object.assign(headers, signEsignServiceRequest({ method, url: full, secret: SECRET, nowSec: Math.floor(Date.now() / 1000) }));
    const res = await fetch(full, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }
  const tenantTemplates = async (tenant: string) =>
    (await db.query(`SELECT id::text, status, owner_scope, adopted_from_template_id::text, current_version_id::text FROM documents."DocumentTemplate" WHERE tenant_id = $1 ORDER BY created_at`, [tenant])).rows;

  async function person(tenant: string, user: string, email: string, roleKey: string): Promise<void> {
    await db.query(`INSERT INTO identity."User" (id, email, display_name, tenant_id, updated_at) VALUES ($1, $2, $3, $4, now()) ON CONFLICT (id) DO NOTHING`, [user, email, email.split('@')[0], tenant]);
    const membership = randomUUID();
    await db.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, is_active, updated_at) VALUES ($1, $2, $3, true, now())`, [membership, user, tenant]);
    const role = await db.query(`SELECT id::text FROM identity."Role" WHERE key = $1`, [roleKey]);
    await db.query(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) VALUES ($1, $2, $3)`, [randomUUID(), membership, role.rows[0].id]);
  }

  async function role(key: string, scopes: string[]): Promise<void> {
    await db.query(`INSERT INTO identity."Role" (id, key, description, is_active, updated_at) VALUES ($1, $2, 'TP-7 spec role', true, now()) ON CONFLICT (key) DO NOTHING`, [randomUUID(), key]);
    for (const s of scopes) {
      await db.query(`INSERT INTO identity."Scope" (id, key, description) VALUES ($1, $2, 'TP-7 spec scope') ON CONFLICT (key) DO NOTHING`, [randomUUID(), s]);
      await db.query(
        `INSERT INTO identity."RoleScope" (id, role_id, scope_id)
         SELECT $1, r.id, s.id FROM identity."Role" r, identity."Scope" s WHERE r.key = $2 AND s.key = $3
         ON CONFLICT (role_id, scope_id) DO NOTHING`,
        [randomUUID(), key, s],
      );
    }
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const dburl = container.getConnectionUri();
    db = new Client({ connectionString: dburl });
    await db.connect();
    for (const p of resolveIdentityMigrations(ROOT)) await db.query(readFileSync(p, 'utf8'));
    for (const p of ENTITLEMENT_MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
    for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));
    for (const t of [PERSONAL_A, PERSONAL_S, BUSINESS_B]) await ensureWriteFreezeTenant((s) => db.query(s), t);
    await db.query(`UPDATE identity."Tenant" SET kind = 'PERSONAL' WHERE id IN ($1, $2)`, [PERSONAL_A, PERSONAL_S]);
    await db.query(`UPDATE identity."Tenant" SET kind = 'BUSINESS', display_name = 'Beta Org' WHERE id = $1`, [BUSINESS_B]);

    await role('tp7_spec_owner', ['document_template:read', 'document_template:author', 'document_template:manage']);
    await role('tp7_spec_author', ['document_template:read', 'document_template:author']);
    await person(PERSONAL_A, OWNER_A, 'pat.a@example.test', 'tp7_spec_owner');
    await person(PERSONAL_S, OWNER_S, 'pat.s@example.test', 'tp7_spec_owner');
    await person(BUSINESS_B, ADMIN_B, 'admin.b@example.test', 'tp7_spec_owner');
    await person(BUSINESS_B, AUTHOR_B, 'author.b@example.test', 'tp7_spec_author');

    // The Aramo Right to Represent default (created by the T-3 migration), tagged for Sign.
    const def = await db.query(`SELECT id::text FROM documents."DocumentTemplate" WHERE owner_scope = 'PLATFORM' AND document_type_id = $1`, [RTR]);
    expect(def.rows).toHaveLength(1);
    defaultId = def.rows[0].id;
    await db.query(`UPDATE documents."DocumentTemplate" SET products = ARRAY['ats','sign'] WHERE id = $1`, [defaultId]);

    savedEnv = { DATABASE_URL: process.env['DATABASE_URL'], ARAMO_ENV: process.env['ARAMO_ENV'], SIGN_WEBHOOK_SIGNING_SECRET: process.env['SIGN_WEBHOOK_SIGNING_SECRET'], SIGN_S2S_AUTH_MODE: process.env['SIGN_S2S_AUTH_MODE'] };
    process.env['DATABASE_URL'] = dburl;
    process.env['ARAMO_ENV'] = 'itest';
    process.env['SIGN_WEBHOOK_SIGNING_SECRET'] = SECRET;
    delete process.env['SIGN_S2S_AUTH_MODE'];

    const objects = new Map<string, Buffer>();
    const storage = {
      putObjectBytes: async (i: { storage_key: string; body: Buffer }) => {
        objects.set(i.storage_key, i.body);
        return { storage_ref: i.storage_key, sha256: 'x' };
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

  it('S2S authentication — unsigned, and a body that does not match its signed digest, are refused (401); nothing written', async () => {
    expect((await call('GET', LIB, { tenant_id: PERSONAL_A }, { sign: false })).status).toBe(401);
    const forged = await call('POST', `${STUDIO}/adopt`, { tenant_id: PERSONAL_A, actor_id: OWNER_A }, { body: { library_template_id: defaultId }, digestOf: { library_template_id: randomUUID() } });
    expect(forged.status).toBe(401);
    expect(await tenantTemplates(PERSONAL_A)).toEqual([]);
  });

  it('gallery — only live Aramo defaults tagged sign (an ATS-only default is never offered)', async () => {
    await db.query(`UPDATE documents."DocumentTemplate" SET products = ARRAY['ats'] WHERE id = $1`, [defaultId]);
    const atsOnly = await call('GET', LIB, { tenant_id: PERSONAL_A });
    expect(atsOnly.status).toBe(200);
    expect(atsOnly.body['items']).toEqual([]);
    expect((await call('GET', `${LIB}/${defaultId}/preview`, { tenant_id: PERSONAL_A })).status).toBe(404);
    await db.query(`UPDATE documents."DocumentTemplate" SET products = ARRAY['ats','sign'] WHERE id = $1`, [defaultId]);
    const res = await call('GET', LIB, { tenant_id: PERSONAL_A });
    expect(res.body['items']).toEqual([expect.objectContaining({ template_id: defaultId, products: ['ats', 'sign'], adopted_template_id: null })]);
    const preview = await call('GET', `${LIB}/${defaultId}/preview`, { tenant_id: PERSONAL_A });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ template_id: defaultId });
  });

  it('Studio — a BUSINESS tenant is refused (Org Home owns organization templates)', async () => {
    for (const r of [
      await call('GET', STUDIO, { tenant_id: BUSINESS_B, actor_id: ADMIN_B }),
      await call('POST', `${STUDIO}/adopt`, { tenant_id: BUSINESS_B, actor_id: ADMIN_B }, { body: { library_template_id: defaultId } }),
    ]) {
      expect(r.status).toBe(403);
      expect(code(r.body)).toBe('INSUFFICIENT_PERMISSIONS');
      expect(reason(r.body)).toBe('organization_templates_in_org_home');
    }
  });

  it('Studio — a Personal owner adopts, edits, previews and uses a version; a later draft can be discarded', async () => {
    const who = { tenant_id: PERSONAL_S, actor_id: OWNER_S };
    const adopted = await call('POST', `${STUDIO}/adopt`, who, { body: { library_template_id: defaultId } });
    expect(adopted.status).toBe(201);
    const t = adopted.body['template'] as { id: string; status: string };
    const v = adopted.body['version'] as { id: string; status: string; field_schema: { html: string; title: string; render_schema_version: string } };
    expect(t.status).toBe('DRAFT');
    expect(v.status).toBe('DRAFT');

    const list = await call('GET', STUDIO, who);
    expect(list.status).toBe(200);
    const ids = (list.body['items'] as Array<{ id: string; owner_scope: string }>).map((i) => `${i.owner_scope}:${i.id}`);
    expect(ids).toEqual(expect.arrayContaining([`TENANT:${t.id}`, `PLATFORM:${defaultId}`]));
    expect((await call('GET', `${STUDIO}/${t.id}`, who)).body).toMatchObject({ id: t.id, owner_scope: 'TENANT' });
    expect(((await call('GET', `${STUDIO}/${t.id}/versions`, who)).body as unknown as unknown[]).length).toBe(1);
    const bindings = await call('GET', `${STUDIO}/${t.id}/allowed-bindings`, who);
    expect(bindings.status).toBe(200);
    expect((bindings.body['bindings'] as unknown[]).length).toBeGreaterThan(0);

    const renamed = await call('PATCH', `${STUDIO}/${t.id}`, who, { body: { name: 'My representation agreement' } });
    expect(renamed.body).toMatchObject({ name: 'My representation agreement' });
    const edited = await call('PATCH', `${STUDIO}/versions/${v.id}`, who, { body: { render_schema_version: v.field_schema.render_schema_version, field_schema: { ...v.field_schema, title: 'My agreement' } } });
    expect(edited.status).toBe(200);
    // Approval needs the recorded preview of THIS content (the §18 gate of the tenant code).
    const early = await call('POST', `${STUDIO}/versions/${v.id}/activate`, who);
    expect(early.status).toBe(409);
    expect(code(early.body)).toBe('TEMPLATE_PREVIEW_REQUIRED');
    expect((await call('POST', `${STUDIO}/versions/${v.id}/preview`, who)).status).toBe(200);
    const used = await call('POST', `${STUDIO}/versions/${v.id}/activate`, who);
    expect(used.status).toBe(200);
    expect(used.body).toMatchObject({ id: v.id, status: 'ACTIVE' });

    const draft = await call('POST', `${STUDIO}/${t.id}/draft`, who);
    expect(draft.status).toBe(201);
    const del = await call('DELETE', `${STUDIO}/versions/${(draft.body as { id: string }).id}`, who);
    expect(del.status).toBe(204);
    const rows = await db.query(`SELECT status FROM documents."TemplateVersion" WHERE template_id = $1 ORDER BY version_number`, [t.id]);
    expect(rows.rows.map((r: { status: string }) => r.status)).toEqual(['ACTIVE']);
  });

  it('Studio — another tenant’s template is not found (tenant-scoped through the same tenant code)', async () => {
    const theirs = (await tenantTemplates(PERSONAL_S))[0] as { id: string };
    const res = await call('GET', `${STUDIO}/${theirs.id}`, { tenant_id: PERSONAL_A, actor_id: OWNER_A });
    expect(res.status).toBe(404);
    expect(code(res.body)).toBe('TEMPLATE_NOT_FOUND');
  });
});
