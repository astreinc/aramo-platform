import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, resolveEntitlementMigrations } from '@aramo/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Document, HeadingLevel, Packer, PageBreak, Paragraph, Table, TableCell, TableRow } from 'docx';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { EFFECTIVE_AUTHORIZATION_RESOLVER, PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';

import { AppModule } from '../app.module.js';

import { ConfigurableTestResolver } from './support/test-auth-harness.js';
import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';
import { grantTemplateProductEntitlements } from './helpers/template-product-entitlements.js';

// HF-AUTH-1 — compact tokens carry no scopes; the guard resolves via this resolver.
const __authzTestResolver = new ConfigurableTestResolver();

// TEMPLATE-IMPORT-1 (Aramo-Template-Word-Import-Directive-v1_1-LOCKED) §5 tests 3–5 — the Word
// import end-to-end through a booted AppModule on real Postgres 17:
//   - a platform operator imports a .docx: a v2 DRAFT is created through the normaliser (a known
//     `{{key}}` becomes a variable; an unknown one stays text and is listed), with the summary
//     and a GLOBAL audit event that carries file facts only;
//   - a second import while the draft is open is refused (409 draft_exists); a wrong file type
//     is refused (422) with nothing written; :read cannot import;
//   - publishing refuses the unresolved placeholder (CONTENT-2 C-17); once reworded it
//     publishes;
//   - a tenant adopts the imported master unchanged (rtr-html-v2 content copied as-is).
// Skipped unless ARAMO_RUN_INTEGRATION=1.
const ROOT = resolve(__dirname, '../../../..');
const AUDIENCE = 'aramo-template-import-1-http-spec';
const ALG = 'RS256';
const ENTITLEMENT_MIGRATIONS = resolveEntitlementMigrations(ROOT);
const IDENTITY_INIT = resolve(ROOT, 'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql');
function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
const TENANT = '01900000-0000-7000-8000-0000000001e1';
const OPERATOR = '00000000-0000-7000-8000-0000000001e2';
const TENANT_ADMIN = '00000000-0000-7000-8000-0000000001e3';
const RTR = 'd0c50005-0000-7000-8000-000000000001';
const READ = 'platform:document_template:read';
const MANAGE = 'platform:document_template:manage';

async function handbookDocx(): Promise<string> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: 'Employee Handbook', heading: HeadingLevel.TITLE }),
          new Paragraph({ text: 'Welcome', heading: HeadingLevel.HEADING_1 }),
          new Paragraph('This handbook is for {{talent.full_name}}. Questions go to {{hr_contact}}.'),
          new Paragraph({ text: 'Benefits', heading: HeadingLevel.HEADING_2 }),
          new Table({
            rows: [
              new TableRow({ tableHeader: true, children: [new TableCell({ children: [new Paragraph('Benefit')] }), new TableCell({ children: [new Paragraph('Who')] })] }),
              new TableRow({ children: [new TableCell({ children: [new Paragraph('Paid time off')] }), new TableCell({ children: [new Paragraph('Everyone')] })] }),
            ],
          }),
          new Paragraph({ children: [new PageBreak()] }),
          new Paragraph({ text: 'Policies', heading: HeadingLevel.HEADING_1 }),
        ],
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc)).toString('base64');
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('TEMPLATE-IMPORT-1 Word import — HTTP (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let module: TestingModule;
  let db: Client;
  let port = 0;
  let savedEnv: Partial<Record<string, string | undefined>> = {};
  let operatorJwt = '';
  let readerJwt = '';
  let tenantJwt = '';
  let templateId = '';
  let draftId = '';
  let docx = '';

  async function signJwt(key: unknown, args: { sub: string; consumer: string; tenant: string; scopes: string[] }): Promise<string> {
    return new SignJWT({
      sub: args.sub,
      consumer_type: args.consumer,
      actor_kind: 'user',
      tenant_id: args.tenant,
      authz_version: __authzTestResolver.grant(args.tenant, args.sub, args.scopes),
    })
      .setProtectedHeader({ alg: ALG }).setIssuedAt().setIssuer('Aramo Core Auth').setAudience(AUDIENCE).setExpirationTime('1h')
      .sign(key as never);
  }
  const auth = (jwt: string): { headers: Record<string, string> } => ({ headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' } });
  const url = (p: string): string => `http://127.0.0.1:${port}${p}`;
  const post = async (jwt: string, path: string, body?: unknown) => {
    const res = await fetch(url(path), { method: 'POST', ...auth(jwt), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, body: (text.length > 0 ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  const reasonOf = (b: Record<string, unknown>) => ((b['error'] as { details?: { reason?: string } } | undefined)?.details?.reason ?? null);
  const versionCount = async () => Number((await db.query(`SELECT count(*)::int c FROM documents."TemplateVersion" WHERE template_id = $1`, [templateId])).rows[0].c);

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const dburl = container.getConnectionUri();
    db = new Client({ connectionString: dburl });
    await db.connect();
    for (const m of ENTITLEMENT_MIGRATIONS) await db.query(readFileSync(m, 'utf8'));
    for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));
    await db.query(readFileSync(IDENTITY_INIT, 'utf8'));
    for (const t of [TENANT, PLATFORM_TENANT_SENTINEL_ID]) await ensureWriteFreezeTenant((s) => db.query(s), t);
    await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source) VALUES ($1::uuid,'core', 'PROVISIONING') ON CONFLICT DO NOTHING`, [TENANT]);
    await grantTemplateProductEntitlements((q, params) => db.query(q, params), TENANT);

    const kp = await generateKeyPair(ALG);
    const publicPem = await exportSPKI(kp.publicKey as never);
    savedEnv = { DATABASE_URL: process.env['DATABASE_URL'], AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'], AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'], ARAMO_ENV: process.env['ARAMO_ENV'] };
    process.env['DATABASE_URL'] = dburl; process.env['AUTH_AUDIENCE'] = AUDIENCE; process.env['AUTH_PUBLIC_KEY'] = publicPem; process.env['ARAMO_ENV'] = 'itest';
    operatorJwt = await signJwt(kp.privateKey, { sub: OPERATOR, consumer: 'platform', tenant: PLATFORM_TENANT_SENTINEL_ID, scopes: ['platform:tenant:read', READ, MANAGE] });
    readerJwt = await signJwt(kp.privateKey, { sub: '00000000-0000-7000-8000-0000000001e4', consumer: 'platform', tenant: PLATFORM_TENANT_SENTINEL_ID, scopes: ['platform:tenant:read', READ] });
    tenantJwt = await signJwt(kp.privateKey, { sub: TENANT_ADMIN, consumer: 'recruiter', tenant: TENANT, scopes: ['auth:session:read', 'document_template:read', 'document_template:author', 'document_template:manage'] });

    module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EFFECTIVE_AUTHORIZATION_RESOLVER).useValue(__authzTestResolver).compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
    await app.init();
    const server = await app.listen(0);
    port = (server.address() as AddressInfo).port;

    const created = await post(operatorJwt, '/platform/document-templates', { document_type_id: RTR, name: 'Employee handbook', template_kind: 'GENERATED', products: ['ats'] });
    expect(created.status).toBe(201);
    templateId = created.body['id'] as string;
    docx = await handbookDocx();
  }, 240_000);

  afterAll(async () => {
    await app?.close(); await db?.end(); await container?.stop();
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }, 60_000);

  it(':read cannot import; a wrong file type is refused with nothing written', async () => {
    expect((await post(readerJwt, `/platform/document-templates/${templateId}/versions/import`, { filename: 'Handbook.docx', content_base64: docx })).status).toBe(403);
    const bad = await post(operatorJwt, `/platform/document-templates/${templateId}/versions/import`, { filename: 'Handbook.pdf', content_base64: docx });
    expect(bad.status).toBe(422);
    expect(reasonOf(bad.body)).toBe('import_file_type');
    expect(await versionCount()).toBe(0);
  });

  it('imports a v2 DRAFT through the normaliser, with the summary and a file-facts-only audit event', async () => {
    const res = await post(operatorJwt, `/platform/document-templates/${templateId}/versions/import`, { filename: 'Handbook.docx', content_base64: docx });
    expect(res.status).toBe(201);
    const version = res.body['version'] as { id: string; status: string; render_schema_version: string; field_schema: { title: string; html: string } };
    draftId = version.id;
    expect(version).toMatchObject({ status: 'DRAFT', render_schema_version: 'rtr-html-v2' });
    expect(version.field_schema.title).toBe('Employee Handbook');
    expect(version.field_schema.html).toBe(
      '<h2>Welcome</h2><p>This handbook is for <span data-field="talent.full_name"></span>. Questions go to {{hr_contact}}.</p>' +
        '<h3>Benefits</h3><table><tr><th>Benefit</th><th>Who</th></tr><tr><td>Paid time off</td><td>Everyone</td></tr></table>' +
        '<hr data-break="page"><h2>Policies</h2>',
    );
    expect(res.body['summary']).toMatchObject({
      title: 'Employee Handbook',
      counts: { h2: 2, h3: 1, p: 1, table: 1, page_break: 1 },
      warnings: [],
      unknown_placeholders: [{ key: 'hr_contact', count: 1 }],
    });
    const ev = await db.query(
      `SELECT tenant_id, actor_id::text, subject_id::text, event_payload FROM identity."IdentityAuditEvent" WHERE event_type = 'identity.document_template.platform_imported'`,
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]).toMatchObject({ tenant_id: null, actor_id: OPERATOR, subject_id: draftId });
    expect(ev.rows[0].event_payload).toMatchObject({ template_id: templateId, source_filename: 'Handbook.docx' });
    expect(JSON.stringify(ev.rows[0].event_payload)).not.toContain('handbook is for');
  });

  it('a second import while the draft is open is refused (409 draft_exists)', async () => {
    const res = await post(operatorJwt, `/platform/document-templates/${templateId}/versions/import`, { filename: 'Handbook.docx', content_base64: docx });
    expect(res.status).toBe(409);
    expect(reasonOf(res.body)).toBe('draft_exists');
    expect(await versionCount()).toBe(1);
  });

  it('publishing refuses the unresolved placeholder; once reworded the draft publishes', async () => {
    expect((await post(operatorJwt, `/platform/document-templates/versions/${draftId}/preview`)).status).toBe(200);
    const refused = await post(operatorJwt, `/platform/document-templates/versions/${draftId}/publish`);
    expect(refused.status).toBe(422);
    expect(reasonOf(refused.body)).toBe('unresolved_placeholder');

    const current = (await (await fetch(url(`/platform/document-templates/versions/${draftId}`), auth(operatorJwt))).json()) as { field_schema: { title: string; html: string } };
    const html = current.field_schema.html.replace('{{hr_contact}}', 'the HR team');
    const patched = await fetch(url(`/platform/document-templates/versions/${draftId}`), {
      method: 'PATCH',
      ...auth(operatorJwt),
      body: JSON.stringify({ render_schema_version: 'rtr-html-v2', field_schema: { render_schema_version: 'rtr-html-v2', title: current.field_schema.title, html } }),
    });
    expect(patched.status).toBe(200);
    expect((await post(operatorJwt, `/platform/document-templates/versions/${draftId}/preview`)).status).toBe(200);
    const pub = await post(operatorJwt, `/platform/document-templates/versions/${draftId}/publish`);
    expect(pub.status).toBe(200);
    expect(pub.body['status']).toBe('ACTIVE');
  });

  it('a tenant adopts the imported master unchanged', async () => {
    const res = await post(tenantJwt, '/v1/document-templates/adopt', { library_template_id: templateId });
    expect(res.status).toBe(201);
    const v = res.body['version'] as { id: string };
    const row = await db.query(`SELECT render_schema_version, field_schema FROM documents."TemplateVersion" WHERE id = $1`, [v.id]);
    const published = await db.query(`SELECT field_schema FROM documents."TemplateVersion" WHERE id = $1`, [draftId]);
    expect(row.rows[0].render_schema_version).toBe('rtr-html-v2');
    expect(row.rows[0].field_schema.html).toBe(published.rows[0].field_schema.html);
  });
});
