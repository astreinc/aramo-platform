import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, resolveIdentityMigrations, resolveEntitlementMigrations } from '@aramo/common';
import { EFFECTIVE_AUTHORIZATION_RESOLVER } from '@aramo/auth';
import { TemplatesRepository } from '@aramo/documents';
import { signEsignServiceRequest } from '@aramo/documents-contracts';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app.module.js';
import { RtrTemplateResolverService } from '../rtr/rtr-template-resolver.service.js';

import { grantLegacyPlatformSelection } from './helpers/legacy-template-selection.js';
import { grantTemplateProductEntitlements } from './helpers/template-product-entitlements.js';
import { ConfigurableTestResolver } from './support/test-auth-harness.js';
import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

const __authzTestResolver = new ConfigurableTestResolver();

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §6 — tag inheritance and
// enforcement through a booted AppModule on real Postgres 17 (every documents migration,
// including 20261103120000):
//   §6.1 a tenant template inherits its tags (from the type at create, copied at Adopt); no
//        tenant route accepts `products`;
//   §6.2 the platform RTR default carries {ats,sign};
//   §6.3 E = the tenant's entitlement capabilities — the gallery, the default preview, Adopt
//        and the withdrawal notices offer only defaults whose products ∩ E ≠ ∅; Aramo Sign lists
//        only templates tagged `sign`; the ATS RTR resolver resolves only templates tagged `ats`.
// Skipped unless ARAMO_RUN_INTEGRATION=1.
const ROOT = resolve(__dirname, '../../../..');
const AUDIENCE = 'aramo-tp5-tags-http-spec';
const ALG = 'RS256';
const SECRET = 'tp5-s2s-secret';
const ENTITLEMENT_MIGRATIONS = resolveEntitlementMigrations(ROOT);
function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
const T_SIGN = '01900000-0000-7000-8000-0000000005a1'; // core + sign
const T_ATS = '01900000-0000-7000-8000-0000000005a2'; // core + ats
const T_CORE = '01900000-0000-7000-8000-0000000005a3'; // core only
const ADMIN = '00000000-0000-7000-8000-0000000005b1';
const RTR = 'd0c50005-0000-7000-8000-000000000001';
const SIGN_TYPE = '0d0c0000-0000-7000-8000-0000000005c1'; // EDITABLE {sign}
const ATS_TYPE = '0d0c0000-0000-7000-8000-0000000005c2'; // EDITABLE {ats}
const HTML = (title: string) => ({ render_schema_version: 'rtr-html-v1', title, html: '<p>From <span data-field="organization.name"></span>.</p>', logo: null });

interface Lib {
  items: Array<{ id: string; owner_scope: string; products: string[] | null }>;
  entitled_products: string[];
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('TEMPLATE-PRODUCT-1 TP-5 tag inheritance + enforcement — HTTP (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let module: TestingModule;
  let db: Client;
  let port = 0;
  let savedEnv: Partial<Record<string, string | undefined>> = {};
  const jwt: Record<string, string> = {};
  let rtrDefault = '';
  let signDefault = '';
  let atsDefault = '';

  const url = (p: string): string => `http://127.0.0.1:${port}${p}`;
  const auth = (tenant: string): { headers: Record<string, string> } => ({
    headers: { Authorization: `Bearer ${jwt[tenant]}`, 'Content-Type': 'application/json' },
  });
  async function library(tenant: string): Promise<Lib> {
    const res = await fetch(url('/v1/document-templates/library'), auth(tenant));
    expect(res.status).toBe(200);
    return (await res.json()) as Lib;
  }
  async function signList(tenant: string): Promise<string[]> {
    const full = url(`/v1/documents/esign/templates?tenant_id=${tenant}`);
    const res = await fetch(full, { headers: { 'content-type': 'application/json', ...signEsignServiceRequest({ method: 'GET', url: full, secret: SECRET, nowSec: Math.floor(Date.now() / 1000) }) } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: Array<{ template_id: string }> }).items.map((i) => i.template_id);
  }
  async function documentType(id: string, key: string, products: string[]): Promise<void> {
    await db.query(
      `INSERT INTO documents."DocumentType" (id, tenant_id, key, name, scope, execution_mode_default, retention_class, system_defined, active, type_class, template_kind, products, category)
       VALUES ($1, NULL, $2, $2, 'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD', false, true, 'TEMPLATE', 'EDITABLE', $3::text[], 'Legal')`,
      [id, key, products],
    );
  }
  async function platformDefault(typeId: string, name: string, products: string[]): Promise<string> {
    const id = randomUUID();
    const ver = randomUUID();
    await db.query(
      `INSERT INTO documents."DocumentTemplate" (id, tenant_id, owner_scope, document_type_id, name, template_kind, status, products, created_by)
       VALUES ($1, NULL, 'PLATFORM', $2, $3, 'GENERATED', 'ACTIVE', $4::text[], $5)`,
      [id, typeId, name, products, ADMIN],
    );
    await db.query(
      `INSERT INTO documents."TemplateVersion" (id, tenant_id, template_id, version_number, status, render_schema_version, field_schema, created_by, activated_at)
       VALUES ($1, NULL, $2, 1, 'ACTIVE', 'rtr-html-v1', $3::jsonb, $4, now())`,
      [ver, id, JSON.stringify(HTML(name)), ADMIN],
    );
    await db.query(`UPDATE documents."DocumentTemplate" SET current_version_id = $2 WHERE id = $1`, [id, ver]);
    return id;
  }
  async function tenantTemplate(tenant: string, typeId: string, name: string, products: string[] | null): Promise<string> {
    const id = randomUUID();
    const ver = randomUUID();
    await db.query(
      `INSERT INTO documents."DocumentTemplate" (id, tenant_id, owner_scope, document_type_id, name, template_kind, status, products, created_by)
       VALUES ($1, $2, 'TENANT', $3, $4, 'GENERATED', 'ACTIVE', $5::text[], $6)`,
      [id, tenant, typeId, name, products, ADMIN],
    );
    await db.query(
      `INSERT INTO documents."TemplateVersion" (id, tenant_id, template_id, version_number, status, render_schema_version, field_schema, created_by, activated_at)
       VALUES ($1, $2, $3, 1, 'ACTIVE', 'rtr-html-v1', $4::jsonb, $5, now())`,
      [ver, tenant, id, JSON.stringify(HTML(name)), ADMIN],
    );
    await db.query(`UPDATE documents."DocumentTemplate" SET current_version_id = $2 WHERE id = $1`, [id, ver]);
    return id;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const dburl = container.getConnectionUri();
    db = new Client({ connectionString: dburl });
    await db.connect();
    for (const p of resolveIdentityMigrations(ROOT)) await db.query(readFileSync(p, 'utf8'));
    for (const p of ENTITLEMENT_MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
    for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));
    const q = (sql: string, params: unknown[]) => db.query(sql, params);
    for (const t of [T_SIGN, T_ATS, T_CORE]) {
      await ensureWriteFreezeTenant((s) => db.query(s), t);
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source) VALUES ($1::uuid,'core','PROVISIONING') ON CONFLICT DO NOTHING`, [t]);
    }
    await grantTemplateProductEntitlements(q, T_SIGN, ['sign']);
    await grantTemplateProductEntitlements(q, T_ATS, ['ats']);

    rtrDefault = (await db.query(`SELECT id::text FROM documents."DocumentTemplate" WHERE owner_scope = 'PLATFORM' AND document_type_id = $1`, [RTR])).rows[0].id;
    await documentType(SIGN_TYPE, 'TP5_SIGN_NDA', ['sign']);
    await documentType(ATS_TYPE, 'TP5_ATS_LETTER', ['ats']);
    signDefault = await platformDefault(SIGN_TYPE, 'Aramo Sign NDA', ['sign']);
    atsDefault = await platformDefault(ATS_TYPE, 'Aramo ATS letter', ['ats']);

    const kp = await generateKeyPair(ALG);
    const scopes = ['auth:session:read', 'document_template:read', 'document_template:author', 'document_template:manage'];
    for (const t of [T_SIGN, T_ATS, T_CORE]) {
      jwt[t] = await new SignJWT({ sub: ADMIN, consumer_type: 'org', actor_kind: 'user', tenant_id: t, authz_version: __authzTestResolver.grant(t, ADMIN, scopes) })
        .setProtectedHeader({ alg: ALG }).setIssuedAt().setIssuer('Aramo Core Auth').setAudience(AUDIENCE).setExpirationTime('1h')
        .sign(kp.privateKey as never);
    }
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
    process.env['AUTH_PUBLIC_KEY'] = await exportSPKI(kp.publicKey as never);
    process.env['ARAMO_ENV'] = 'itest';
    process.env['SIGN_WEBHOOK_SIGNING_SECRET'] = SECRET;
    delete process.env['SIGN_S2S_AUTH_MODE'];
    module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EFFECTIVE_AUTHORIZATION_RESOLVER).useValue(__authzTestResolver).compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
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

  it('§6.2 backfill — the platform RTR default carries {ats,sign}; the new CHECK replaced the PLATFORM-only one', async () => {
    const r = await db.query(`SELECT products FROM documents."DocumentTemplate" WHERE id = $1`, [rtrDefault]);
    expect(r.rows[0].products).toEqual(['ats', 'sign']);
    const checks = await db.query(`SELECT conname FROM pg_constraint WHERE conname LIKE 'DocumentTemplate_products_%' ORDER BY conname`);
    expect(checks.rows.map((c: { conname: string }) => c.conname)).toEqual(['DocumentTemplate_products_platform_not_null_check']);
  });

  it('§6.3 gallery — only defaults whose products intersect the tenant entitlements; entitled_products', async () => {
    const sign = await library(T_SIGN);
    expect(sign.items.filter((i) => i.owner_scope === 'PLATFORM').map((i) => i.id).sort()).toEqual([rtrDefault, signDefault].sort());
    expect(sign.entitled_products).toEqual(['sign']);
    const ats = await library(T_ATS);
    expect(ats.items.filter((i) => i.owner_scope === 'PLATFORM').map((i) => i.id).sort()).toEqual([rtrDefault, atsDefault].sort());
    expect(ats.entitled_products).toEqual(['ats']);
    const core = await library(T_CORE);
    expect(core.items.filter((i) => i.owner_scope === 'PLATFORM')).toEqual([]);
    expect(core.entitled_products).toEqual([]);
  });

  it('§6.3 default preview — 404 for a default of a product the tenant does not hold', async () => {
    expect((await fetch(url(`/v1/document-templates/library/${atsDefault}/preview`), auth(T_SIGN))).status).toBe(404);
    expect((await fetch(url(`/v1/document-templates/library/${atsDefault}/preview`), auth(T_ATS))).status).toBe(200);
    expect((await fetch(url(`/v1/document-templates/library/${rtrDefault}/preview`), auth(T_CORE))).status).toBe(404);
  });

  it('§6.1/§6.3 Adopt — refused (404) for an unentitled default; an entitled one copies the default tags', async () => {
    const adopt = (tenant: string, id: string, extra: Record<string, unknown> = {}) =>
      fetch(url('/v1/document-templates/adopt'), { method: 'POST', ...auth(tenant), body: JSON.stringify({ library_template_id: id, ...extra }) });
    expect((await adopt(T_SIGN, atsDefault)).status).toBe(404);
    expect((await adopt(T_SIGN, signDefault, { products: ['ats'] })).status).toBe(422);
    const res = await adopt(T_SIGN, signDefault);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { template: { products: string[]; adopted_from_template_id: string } };
    expect(body.template).toMatchObject({ products: ['sign'], adopted_from_template_id: signDefault });
  });

  it('§6.1 create your own — tags come from the document type; a body with products is refused', async () => {
    const create = (extra: Record<string, unknown> = {}) =>
      fetch(url('/v1/document-templates'), {
        method: 'POST',
        ...auth(T_ATS),
        body: JSON.stringify({ document_type_id: ATS_TYPE, name: 'Our ATS letter', template_kind: 'GENERATED', ...extra }),
      });
    const refused = await create({ products: ['sign'] });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('products_server_owned');
    const res = await create();
    expect(res.status).toBe(201);
    expect(((await res.json()) as { products: string[] }).products).toEqual(['ats']);
    // The DB backstop: a row inserted with NULL products takes its type's products.
    const raw = await tenantTemplate(T_ATS, SIGN_TYPE, 'Raw insert', null);
    expect((await db.query(`SELECT products FROM documents."DocumentTemplate" WHERE id = $1`, [raw])).rows[0].products).toEqual(['sign']);
  });

  it('§6.3 Aramo Sign lists only templates tagged sign', async () => {
    const tagged = await tenantTemplate(T_SIGN, RTR, 'Sign RTR', ['ats', 'sign']);
    const atsOnly = await tenantTemplate(T_SIGN, RTR, 'ATS-only RTR', ['ats']);
    const listed = await signList(T_SIGN);
    expect(listed).toContain(tagged);
    expect(listed).not.toContain(atsOnly);
  });

  it('§6.3 the ATS RTR resolver resolves only templates tagged ats (Sign is_default unaffected for sign-tagged ones)', async () => {
    const resolver = new RtrTemplateResolverService(module.get(TemplatesRepository, { strict: false }));
    const signOnly = await tenantTemplate(T_ATS, RTR, 'Sign-only RTR', ['sign']);
    await db.query(
      `INSERT INTO documents."TenantTemplateSelection" (id, tenant_id, document_type_id, client_id, template_id, selected_by, selected_at) VALUES ($1, $2, $3, NULL, $4, $5, now())
       ON CONFLICT ("tenant_id","document_type_id","client_id") DO UPDATE SET template_id = EXCLUDED.template_id, legacy_platform = NULL`,
      [randomUUID(), T_ATS, RTR, signOnly, ADMIN],
    );
    await expect(resolver.resolveActive({ tenant_id: T_ATS, requestId: 'r' })).rejects.toMatchObject({ code: 'TEMPLATE_SELECTION_REQUIRED' });
    // The same selection resolves for Sign (the template is tagged sign).
    await expect(resolver.resolveActive({ tenant_id: T_ATS, requestId: 'r', product: 'sign' })).resolves.toMatchObject({ template_id: signOnly });
    await db.query(`UPDATE documents."DocumentTemplate" SET products = ARRAY['ats','sign'] WHERE id = $1`, [signOnly]);
    await expect(resolver.resolveActive({ tenant_id: T_ATS, requestId: 'r' })).resolves.toMatchObject({ template_id: signOnly });
  });

  it('§6.3 withdrawal notices — only for defaults the tenant can see', async () => {
    const q = (sql: string, params: unknown[]) => db.query(sql, params);
    for (const t of [T_SIGN, T_ATS]) await grantLegacyPlatformSelection(q, { tenant_id: t, document_type_id: SIGN_TYPE, template_id: signDefault });
    await db.query(
      `UPDATE documents."DocumentTemplate" SET withdraw_notice_at = now(), withdraw_effective_at = now() + interval '30 days' WHERE id = $1`,
      [signDefault],
    );
    const notices = async (tenant: string): Promise<string[]> =>
      ((await (await fetch(url('/v1/document-templates/notices'), auth(tenant))).json()) as { notices: Array<{ template_id: string }> }).notices.map((n) => n.template_id);
    expect(await notices(T_SIGN)).toEqual([signDefault]);
    expect(await notices(T_ATS)).toEqual([]);
  });
});
