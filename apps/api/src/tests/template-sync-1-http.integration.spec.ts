import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, resolveEntitlementMigrations } from '@aramo/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
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

// TEMPLATE-SYNC-1 (Aramo-Template-Sync-1-Directive-v1_0-LOCKED) §5 tests 2 and 3 — "a newer master
// is available", end-to-end through a booted AppModule on real Postgres 17:
//   - Aramo publishes v2 of a default that companies A and B adopted at v1: the `master` flag
//     appears on the template list, GET :id and the library (S-3); publish is audited (S-13);
//   - compare content returns the v2 stored content only (S-5);
//   - A starts a draft from v2: vN+1 with the master content, A's logo kept, the field rows copied
//     and based_on set; it goes through preview and approve, and the flag clears (S-7);
//   - B keeps its version: hidden until v3 (S-8);
//   - a withdrawal lists both adopted copies in the notices (S-4);
//   - draft_exists, already_current, not_an_adopted_template (§3.6); the audit rows (S-13);
//   - the migration backfill sets based_on for adopted versions written before it (§5 test 3).
// Skipped unless ARAMO_RUN_INTEGRATION=1.
const ROOT = resolve(__dirname, '../../../..');
const AUDIENCE = 'aramo-template-sync-1-http-spec';
const ALG = 'RS256';
const ENTITLEMENT_MIGRATIONS = resolveEntitlementMigrations(ROOT);
const IDENTITY_INIT = resolve(ROOT, 'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql');
const SYNC_MIGRATION = '20261125120000_template_sync_1_master_lineage';
function documentsMigrations(opts: { before?: string } = {}): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .filter((n) => opts.before === undefined || n < opts.before)
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}
const TENANT_A = '01900000-0000-7000-8000-0000000005a1';
const TENANT_B = '01900000-0000-7000-8000-0000000005b1';
const OPERATOR = '00000000-0000-7000-8000-0000000005c1';
const ADMIN_A = '00000000-0000-7000-8000-0000000005a2';
const ADMIN_B = '00000000-0000-7000-8000-0000000005b2';
const RTR = 'd0c50005-0000-7000-8000-000000000001';
const MANAGE = 'platform:document_template:manage';
const READ = 'platform:document_template:read';
const TENANT_SCOPES = ['auth:session:read', 'document_template:read', 'document_template:author', 'document_template:manage'];
const LOGO = { asset_id: '00000000-0000-7000-8000-0000000005d1', sha256: 'a'.repeat(64), mime: 'image/png' };
const LOGO_NODE = '<div data-asset="tenant.logo"></div>';
// The master v2's inline field (TEMPLATE-FIELDS-1): a Sign check box for the signer role below.
const MASTER_SIGNING = { roles: [{ role_key: 'party', label: 'Party', kind: 'SIGNER', order: 1 }], routing_mode: 'PARALLEL' };
const MASTER_FIELD = { field_key: 'nda_accepted', field_type: 'CHECKBOX', signer_role: 'party', required: false, ordinal: 0, label: 'Accepted' };

interface MasterView {
  template_id: string;
  current_version_number: number | null;
  based_on_version_number: number | null;
  newer_available: boolean;
  withdrawn: { status: string } | null;
  kept: boolean;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('TEMPLATE-SYNC-1 — a newer master is available (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let module: TestingModule;
  let db: Client;
  let port = 0;
  let savedEnv: Partial<Record<string, string | undefined>> = {};
  let operatorJwt = '';
  let jwtA = '';
  let jwtB = '';
  let masterId = '';
  let copyA = '';
  let copyB = '';
  let masterV2 = '';
  let draftA = '';

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
  const call = async (method: string, jwt: string, path: string, body?: unknown) => {
    const res = await fetch(url(path), { method, ...auth(jwt), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, body: (text.length > 0 ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  const post = (jwt: string, path: string, body?: unknown) => call('POST', jwt, path, body);
  const get = (jwt: string, path: string) => call('GET', jwt, path);
  const reasonOf = (b: Record<string, unknown>) => ((b['error'] as { details?: { reason?: string } } | undefined)?.details?.reason ?? null);
  const masterOf = async (jwt: string, id: string) => (await get(jwt, `/v1/document-templates/${id}`)).body['master'] as MasterView | null;

  // TEMPLATE-FIELDS-1 — a field in a master's text is an inline field: its marker in the html and
  // its row, saved together through the platform PATCH (rtr-html-v3, with signing roles). A row
  // without a marker is refused at publish (field_marker_mismatch), so none is inserted directly.
  async function publishMaster(html: string, withField = false): Promise<string> {
    const rsv = withField ? 'rtr-html-v3' : 'rtr-html-v2';
    const body = withField ? html.replace('</p>', ` <span data-sign-field="${MASTER_FIELD.field_key}"></span></p>`) : html;
    const fs = { render_schema_version: rsv, title: 'Mutual NDA', html: body, ...(withField ? { signing: MASTER_SIGNING } : {}) };
    const draft = await post(operatorJwt, `/platform/document-templates/${masterId}/versions`, { render_schema_version: rsv, field_schema: fs });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const vid = draft.body['id'] as string;
    if (withField) {
      const saved = await call('PATCH', operatorJwt, `/platform/document-templates/versions/${vid}`, { render_schema_version: rsv, field_schema: fs, fields: [MASTER_FIELD] });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    }
    const pv = await post(operatorJwt, `/platform/document-templates/versions/${vid}/preview`);
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    const pub = await post(operatorJwt, `/platform/document-templates/versions/${vid}/publish`);
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    return vid;
  }

  async function adoptAndApprove(jwt: string, withLogo: boolean): Promise<string> {
    const adopted = await post(jwt, '/v1/document-templates/adopt', { library_template_id: masterId });
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(201);
    const tid = (adopted.body['template'] as { id: string }).id;
    const vid = (adopted.body['version'] as { id: string }).id;
    // The company's own wording (and, for A, its captured letterhead logo — server-owned, so set
    // on the DRAFT row directly instead of fetching a tenant-profile logo).
    const fs = withLogo
      ? { render_schema_version: 'rtr-html-v2', title: 'Our NDA', html: `${LOGO_NODE}<p>Our wording v1</p>`, logo: LOGO }
      : { render_schema_version: 'rtr-html-v2', title: 'Our NDA', html: '<p>Our wording v1</p>' };
    await db.query(`UPDATE documents."TemplateVersion" SET field_schema = $2::jsonb, previewed_fingerprint = NULL WHERE id = $1`, [vid, JSON.stringify(fs)]);
    { const r = await post(jwt, `/v1/document-templates/versions/${vid}/preview`); expect(r.status, JSON.stringify(r.body)).toBe(200); }
    { const r = await post(jwt, `/v1/document-templates/versions/${vid}/activate`); expect(r.status, JSON.stringify(r.body)).toBe(200); }
    return tid;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const dburl = container.getConnectionUri();
    db = new Client({ connectionString: dburl });
    await db.connect();
    for (const m of ENTITLEMENT_MIGRATIONS) await db.query(readFileSync(m, 'utf8'));
    for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));
    await db.query(readFileSync(IDENTITY_INIT, 'utf8'));
    for (const t of [TENANT_A, TENANT_B, PLATFORM_TENANT_SENTINEL_ID]) await ensureWriteFreezeTenant((s) => db.query(s), t);
    for (const t of [TENANT_A, TENANT_B]) {
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source) VALUES ($1::uuid,'core', 'PROVISIONING') ON CONFLICT DO NOTHING`, [t]);
      await grantTemplateProductEntitlements((q, params) => db.query(q, params), t);
    }

    const kp = await generateKeyPair(ALG);
    const publicPem = await exportSPKI(kp.publicKey as never);
    savedEnv = { DATABASE_URL: process.env['DATABASE_URL'], AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'], AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'], ARAMO_ENV: process.env['ARAMO_ENV'] };
    process.env['DATABASE_URL'] = dburl; process.env['AUTH_AUDIENCE'] = AUDIENCE; process.env['AUTH_PUBLIC_KEY'] = publicPem; process.env['ARAMO_ENV'] = 'itest';
    operatorJwt = await signJwt(kp.privateKey, { sub: OPERATOR, consumer: 'platform', tenant: PLATFORM_TENANT_SENTINEL_ID, scopes: ['platform:tenant:read', READ, MANAGE] });
    jwtA = await signJwt(kp.privateKey, { sub: ADMIN_A, consumer: 'recruiter', tenant: TENANT_A, scopes: TENANT_SCOPES });
    jwtB = await signJwt(kp.privateKey, { sub: ADMIN_B, consumer: 'recruiter', tenant: TENANT_B, scopes: TENANT_SCOPES });

    module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EFFECTIVE_AUTHORIZATION_RESOLVER).useValue(__authzTestResolver).compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
    await app.init();
    const server = await app.listen(0);
    port = (server.address() as AddressInfo).port;

    // Aramo publishes v1 of a default; companies A (with its logo) and B adopt and approve it.
    const created = await post(operatorJwt, '/platform/document-templates', { document_type_id: RTR, name: 'Mutual NDA', template_kind: 'GENERATED', products: ['sign'] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    masterId = created.body['id'] as string;
    await publishMaster('<p>Master wording v1</p>');
    copyA = await adoptAndApprove(jwtA, true);
    copyB = await adoptAndApprove(jwtB, false);
  }, 240_000);

  afterAll(async () => {
    await app?.close(); await db?.end(); await container?.stop();
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }, 60_000);

  it('adopt-time: based on v1, nothing newer; adopt wrote based_on_platform_version_id', async () => {
    expect(await masterOf(jwtA, copyA)).toMatchObject({ template_id: masterId, current_version_number: 1, based_on_version_number: 1, newer_available: false, withdrawn: null, kept: false });
    const rows = await db.query(`SELECT based_on_platform_version_id FROM documents."TemplateVersion" WHERE template_id = $1`, [copyA]);
    expect(rows.rows.every((r: { based_on_platform_version_id: string | null }) => r.based_on_platform_version_id !== null)).toBe(true);
  });

  it('master v2 published: the flag appears on the list, GET :id and the library; publish is audited', async () => {
    masterV2 = await publishMaster('<p>Master wording v2</p>', true);
    const list = (await get(jwtA, '/v1/document-templates')).body as unknown as Array<{ id: string; master: MasterView | null }>;
    expect(list.find((t) => t.id === copyA)?.master).toMatchObject({ newer_available: true, current_version_number: 2, based_on_version_number: 1 });
    expect((await masterOf(jwtB, copyB))?.newer_available).toBe(true);
    const lib = (await get(jwtA, '/v1/document-templates/library')).body['items'] as Array<{ id: string; owner_scope: string; master: MasterView | null }>;
    expect(lib.find((i) => i.id === copyA)?.master?.newer_available).toBe(true);
    expect(lib.filter((i) => i.owner_scope === 'PLATFORM').every((i) => i.master === null)).toBe(true);
    const ev = await db.query(`SELECT tenant_id, subject_id::text, event_payload FROM identity."IdentityAuditEvent" WHERE event_type = 'identity.document_template.platform_published' ORDER BY created_at`);
    expect(ev.rows).toHaveLength(2);
    expect(ev.rows[1]).toMatchObject({ tenant_id: null, subject_id: masterV2 });
    expect(ev.rows[1].event_payload).toMatchObject({ template_id: masterId, version_id: masterV2, version_number: 2 });
  });

  it('compare content returns the v2 stored content only', async () => {
    const res = await get(jwtA, `/v1/document-templates/${copyA}/master`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ template_id: copyA, master_template_id: masterId, version_id: masterV2, version_number: 2, render_schema_version: 'rtr-html-v2', title: 'Mutual NDA', html: '<p>Master wording v2</p>' });
  });

  it('not_an_adopted_template: a template the company wrote itself', async () => {
    const own = await post(jwtA, '/v1/document-templates', { document_type_id: RTR, name: 'Own', template_kind: 'GENERATED' });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const id = own.body['id'] as string;
    const compare = await get(jwtA, `/v1/document-templates/${id}/master`);
    expect(compare.status, JSON.stringify(compare.body)).toBe(404);
    expect(reasonOf(compare.body)).toBe('not_an_adopted_template');
    const draft = await post(jwtA, `/v1/document-templates/${id}/draft-from-master`);
    expect(draft.status, JSON.stringify(draft.body)).toBe(404);
    expect(reasonOf(draft.body)).toBe('not_an_adopted_template');
    expect((await masterOf(jwtA, id))).toBeNull();
    // Another tenant's copy is never reachable.
    { const r = await get(jwtB, `/v1/document-templates/${copyA}/master`); expect(r.status, JSON.stringify(r.body)).toBe(404); }
  });

  it('draft-from-master: vN+1 with the master content, the logo kept, the field rows copied, based_on set', async () => {
    const res = await post(jwtA, `/v1/document-templates/${copyA}/draft-from-master`);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    draftA = res.body['id'] as string;
    expect(res.body).toMatchObject({ status: 'DRAFT', version_number: 2 });
    const row = (await db.query(`SELECT field_schema, based_on_platform_version_id::text b FROM documents."TemplateVersion" WHERE id = $1`, [draftA])).rows[0];
    expect(row.b).toBe(masterV2);
    expect(row.field_schema.html).toBe(`${LOGO_NODE}<p>Master wording v2 <span data-sign-field="nda_accepted"></span></p>`);
    expect(row.field_schema.logo).toEqual(LOGO);
    const fields = await db.query(`SELECT field_key FROM documents."TemplateFieldDefinition" WHERE template_version_id = $1`, [draftA]);
    expect(fields.rows.map((f: { field_key: string }) => f.field_key)).toEqual(['nda_accepted']);
    // The approved copy is untouched until the company approves the draft.
    const current = (await db.query(`SELECT current_version_id::text c FROM documents."DocumentTemplate" WHERE id = $1`, [copyA])).rows[0].c;
    expect(current).not.toBe(draftA);
  });

  it('draft_exists while that draft is open', async () => {
    const res = await post(jwtA, `/v1/document-templates/${copyA}/draft-from-master`);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(reasonOf(res.body)).toBe('draft_exists');
  });

  it('preview and approve the draft: the flag clears; then already_current', async () => {
    { const r = await post(jwtA, `/v1/document-templates/versions/${draftA}/preview`); expect(r.status, JSON.stringify(r.body)).toBe(200); }
    { const r = await post(jwtA, `/v1/document-templates/versions/${draftA}/activate`); expect(r.status, JSON.stringify(r.body)).toBe(200); }
    expect(await masterOf(jwtA, copyA)).toMatchObject({ newer_available: false, based_on_version_number: 2, current_version_number: 2 });
    for (const path of ['draft-from-master', 'keep-version']) {
      const res = await post(jwtA, `/v1/document-templates/${copyA}/${path}`);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(reasonOf(res.body)).toBe('already_current');
    }
    // A's own next edit keeps the master version it was copied from.
    const own = await post(jwtA, `/v1/document-templates/${copyA}/draft`);
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const b = (await db.query(`SELECT based_on_platform_version_id::text b FROM documents."TemplateVersion" WHERE id = $1`, [own.body['id']])).rows[0].b;
    expect(b).toBe(masterV2);
    await call('DELETE', jwtA, `/v1/document-templates/versions/${own.body['id'] as string}`);
  });

  it('keep-version hides the notice for B until Aramo publishes v3', async () => {
    const kept = await post(jwtB, `/v1/document-templates/${copyB}/keep-version`);
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(await masterOf(jwtB, copyB)).toMatchObject({ newer_available: false, kept: true, based_on_version_number: 1 });
    await publishMaster('<p>Master wording v3</p>');
    expect(await masterOf(jwtB, copyB)).toMatchObject({ newer_available: true, kept: false, current_version_number: 3 });
    expect((await masterOf(jwtA, copyA))?.newer_available).toBe(true);
  });

  it('the audit rows: draft_from_master (A) and master_version_kept (B), tenant-scoped', async () => {
    const ev = await db.query(
      `SELECT event_type, tenant_id::text, subject_id::text, event_payload FROM identity."IdentityAuditEvent" WHERE event_type IN ('identity.document_template.draft_from_master', 'identity.document_template.master_version_kept') ORDER BY created_at`,
    );
    expect(ev.rows).toHaveLength(2);
    expect(ev.rows[0]).toMatchObject({ event_type: 'identity.document_template.draft_from_master', tenant_id: TENANT_A, subject_id: copyA });
    expect(ev.rows[0].event_payload).toMatchObject({ version_id: draftA, master_version_id: masterV2, master_version_number: 2 });
    expect(ev.rows[1]).toMatchObject({ event_type: 'identity.document_template.master_version_kept', tenant_id: TENANT_B, subject_id: copyB });
    expect(ev.rows[1].event_payload).toMatchObject({ master_version_id: masterV2, master_version_number: 2 });
  });

  it('withdrawal lists both adopted copies in the notices and on the master flag', async () => {
    const w = await post(operatorJwt, `/platform/document-templates/${masterId}/withdraw`, { notice_days: 30 });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    for (const [jwt, copy] of [[jwtA, copyA], [jwtB, copyB]] as const) {
      const notices = (await get(jwt, '/v1/document-templates/notices')).body['notices'] as Array<Record<string, unknown>>;
      expect(notices.find((n) => n['template_id'] === copy)).toMatchObject({ master_template_id: masterId, status: 'PENDING' });
      expect((await masterOf(jwt, copy))?.withdrawn?.status).toBe('PENDING');
    }
  });
});

// §5 test 3 — the migration backfill: an adopted template's versions written before
// 20261125120000 get based_on_platform_version_id = the template's adopted_from_version_id.
describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('TEMPLATE-SYNC-1 S-1 — migration backfill (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    for (const m of ENTITLEMENT_MIGRATIONS) await db.query(readFileSync(m, 'utf8'));
    for (const p of documentsMigrations({ before: SYNC_MIGRATION })) await db.query(readFileSync(p, 'utf8'));
  }, 240_000);

  afterAll(async () => {
    await db?.end(); await container?.stop();
  }, 60_000);

  it('sets based_on for every version of an adopted template (ACTIVE and DRAFT) and nothing else', async () => {
    const SYS = '00000000-0000-0000-0000-000000000000';
    const master = '01900000-0000-7000-8000-0000000006a1';
    const masterV1 = '01900000-0000-7000-8000-0000000006a2';
    const copy = '01900000-0000-7000-8000-0000000006b1';
    const own = '01900000-0000-7000-8000-0000000006c1';
    const tenant = '01900000-0000-7000-8000-0000000006d1';
    const fs = JSON.stringify({ render_schema_version: 'rtr-html-v2', title: 'T', html: '<p>x</p>' });
    await db.query(
      `INSERT INTO documents."DocumentTemplate" (id, tenant_id, owner_scope, document_type_id, name, template_kind, status, products, created_by, updated_at)
       VALUES ($1, NULL, 'PLATFORM', $2, 'M', 'GENERATED', 'DRAFT', ARRAY['ats'], $3, now())`,
      [master, RTR, SYS],
    );
    await db.query(
      `INSERT INTO documents."TemplateVersion" (id, tenant_id, template_id, version_number, status, render_schema_version, field_schema, created_by) VALUES ($1, NULL, $2, 1, 'DRAFT', 'rtr-html-v2', $3::jsonb, $4)`,
      [masterV1, master, fs, SYS],
    );
    for (const [id, adoptedFrom, adoptedVersion] of [[copy, master, masterV1], [own, null, null]] as const) {
      await db.query(
        `INSERT INTO documents."DocumentTemplate" (id, tenant_id, owner_scope, document_type_id, name, template_kind, status, products, created_by, updated_at, adopted_from_template_id, adopted_from_version_id)
         VALUES ($1, $2, 'TENANT', $3, 'C', 'GENERATED', 'DRAFT', ARRAY['ats'], $4, now(), $5, $6)`,
        [id, tenant, RTR, SYS, adoptedFrom, adoptedVersion],
      );
      // Version 1 ACTIVE, version 2 the open DRAFT (TemplateVersion_one_draft_per_template allows
      // one DRAFT per template).
      for (const [n, status] of [[1, 'ACTIVE'], [2, 'DRAFT']] as const) {
        await db.query(
          `INSERT INTO documents."TemplateVersion" (id, tenant_id, template_id, version_number, status, render_schema_version, field_schema, created_by, activated_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'rtr-html-v2', $5::jsonb, $6, $7)`,
          [tenant, id, n, status, fs, SYS, status === 'ACTIVE' ? new Date() : null],
        );
      }
    }
    await db.query(`DELETE FROM documents."TemplateVersion" WHERE template_id = $1 AND version_number = 2`, [own]);

    const sql = readFileSync(resolve(ROOT, 'libs/documents/prisma/migrations', SYNC_MIGRATION, 'migration.sql'), 'utf8');
    await db.query(sql);
    await db.query(sql); // idempotent

    const copyRows = await db.query(`SELECT based_on_platform_version_id::text b FROM documents."TemplateVersion" WHERE template_id = $1`, [copy]);
    expect(copyRows.rows).toHaveLength(2);
    expect(copyRows.rows.every((r: { b: string }) => r.b === masterV1)).toBe(true);
    const ownRows = await db.query(`SELECT based_on_platform_version_id b FROM documents."TemplateVersion" WHERE template_id = $1`, [own]);
    expect(ownRows.rows.every((r: { b: string | null }) => r.b === null)).toBe(true);
    const masterRow = await db.query(`SELECT based_on_platform_version_id b FROM documents."TemplateVersion" WHERE id = $1`, [masterV1]);
    expect(masterRow.rows[0].b).toBeNull();
    const kept = await db.query(`SELECT sync_kept_platform_version_id k FROM documents."DocumentTemplate" WHERE id = $1`, [copy]);
    expect(kept.rows[0].k).toBeNull();
    const idx = await db.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'documents' AND indexname IN ('DocumentTemplate_adopted_from_template_id_idx', 'TemplateVersion_based_on_platform_version_id_idx') ORDER BY indexname`,
    );
    expect(idx.rows.map((r: { indexname: string }) => r.indexname)).toEqual(['DocumentTemplate_adopted_from_template_id_idx', 'TemplateVersion_based_on_platform_version_id_idx']);
  });
});
