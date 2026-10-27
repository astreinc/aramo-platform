import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, resolveIdentityMigrations, resolveEntitlementMigrations } from '@aramo/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { EFFECTIVE_AUTHORIZATION_RESOLVER } from '@aramo/auth';
import { TEMPLATE_TENANT_LOGO, type CapturedTenantLogo, type TemplateTenantLogoPort } from '@aramo/documents';

import { AppModule } from '../app.module.js';

import { ConfigurableTestResolver } from './support/test-auth-harness.js';
import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

const __authzTestResolver = new ConfigurableTestResolver();

// TEMPLATE-STUDIO-1 — Implementation Directive v1.0 (LOCKED) §6 B-1 / B-2, §11 item 5,
// through a booted AppModule (real JwtAuthGuard + EntitlementGuard + RolesGuard, org tokens):
//   B-1 — a logo-bearing tenant draft saved with Studio-encoded content (the letterhead node
//         kept first by studioDocToHtml) previews and activates without logo_asset_mismatch;
//         the removal semantics stay server-authoritative: content without the node while the
//         version holds a logo is refused at preview (logo_asset_mismatch) until the logo is
//         removed through DELETE /versions/:id/logo (reference + node together).
//   B-2 — tenant allowed-bindings carries data_type / sample_value / active from the
//         TemplateVariable catalog (additive; the offered set is unchanged, A2 holds).
// The tenant-profile logo fetch is stubbed (TEMPLATE_TENANT_LOGO) — capture is not under test.
// Skipped unless ARAMO_RUN_INTEGRATION=1.
const ROOT = resolve(__dirname, '../../../..');
const AUDIENCE = 'aramo-template-studio-1-b12-http-spec';
const ALG = 'RS256';
const ENTITLEMENT_MIGRATIONS = resolveEntitlementMigrations(ROOT);
function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
const TENANT_A = '01900000-0000-7000-8000-0000000000f1';
const ADMIN_A = '00000000-0000-7000-8000-00000000f1a1';
const RTR = 'd0c50005-0000-7000-8000-000000000001';
const HTML_SCHEMA = 'rtr-html-v1';
const LOGO_NODE = '<div data-asset="tenant.logo"></div>';
// The exact html the Studio codec (libs/document-templates-web studio-codec.spec.ts
// TENANT_LOGO_HTML) decodes and re-encodes byte-for-byte for a logo-bearing tenant draft.
const STUDIO_ENCODED_HTML =
  '<div data-asset="tenant.logo"></div><h2>Right to represent</h2><p>We represent <span data-field="talent.full_name"></span> for <span data-field="requisition.title"></span>.</p>';
const DATA_TYPES = ['TEXT', 'MULTILINE_TEXT', 'DATE', 'NUMBER', 'CURRENCY'];

const CAPTURED: CapturedTenantLogo = {
  sha256: 'a'.repeat(64),
  mime: 'image/png',
  storage_provider: 'local',
  storage_locator: 'itest/tenant-logo.png',
  byte_size: 68,
};
const stubLogo: TemplateTenantLogoPort = {
  async info() {
    return { available: true, tenant_name: 'Acme Studio Staffing' };
  },
  async capture() {
    return CAPTURED;
  },
  async read() {
    return Buffer.from('');
  },
};

interface VersionView {
  id: string;
  field_schema: { html: string; title: string; logo?: { asset_id: string } | null };
  logo: { asset_id: string; mime: string } | null;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TEMPLATE-STUDIO-1 B-1/B-2 tenant template Studio backend — HTTP (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let adminA = '';

    async function signJwt(key: unknown, args: { sub: string; tenant: string; scopes: string[] }): Promise<string> {
      return new SignJWT({
        sub: args.sub,
        consumer_type: 'org',
        actor_kind: 'user',
        tenant_id: args.tenant,
        authz_version: __authzTestResolver.grant(args.tenant, args.sub, args.scopes),
      })
        .setProtectedHeader({ alg: ALG }).setIssuedAt().setIssuer('Aramo Core Auth').setAudience(AUDIENCE).setExpirationTime('1h')
        .sign(key as never);
    }
    const auth = (jwt: string): { headers: Record<string, string> } => ({ headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' } });
    const url = (p: string): string => `http://127.0.0.1:${port}${p}`;

    async function createTemplateWithDraft(name: string): Promise<{ templateId: string; versionId: string }> {
      const t = await fetch(url('/v1/document-templates'), {
        method: 'POST',
        ...auth(adminA),
        body: JSON.stringify({ document_type_id: RTR, name, template_kind: 'GENERATED' }),
      });
      expect(t.status).toBe(201);
      const templateId = ((await t.json()) as { id: string }).id;
      const v = await fetch(url(`/v1/document-templates/${templateId}/versions`), {
        method: 'POST',
        ...auth(adminA),
        body: JSON.stringify({
          render_schema_version: HTML_SCHEMA,
          field_schema: { render_schema_version: HTML_SCHEMA, title: name, html: '<h2>Right to represent</h2><p>We represent <span data-field="talent.full_name"></span>.</p>' },
        }),
      });
      expect(v.status).toBe(201);
      return { templateId, versionId: ((await v.json()) as { id: string }).id };
    }
    async function getVersion(versionId: string): Promise<VersionView> {
      const res = await fetch(url(`/v1/document-templates/versions/${versionId}`), auth(adminA));
      expect(res.status).toBe(200);
      return (await res.json()) as VersionView;
    }
    const patchHtml = (versionId: string, title: string, html: string): Promise<Response> =>
      fetch(url(`/v1/document-templates/versions/${versionId}`), {
        method: 'PATCH',
        ...auth(adminA),
        body: JSON.stringify({ field_schema: { render_schema_version: HTML_SCHEMA, title, html } }),
      });
    const post = (p: string): Promise<Response> => fetch(url(p), { method: 'POST', ...auth(adminA) });

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const dburl = container.getConnectionUri();
      db = new Client({ connectionString: dburl });
      await db.connect();
      for (const p of resolveIdentityMigrations(ROOT)) await db.query(readFileSync(p, 'utf8'));
      for (const m of ENTITLEMENT_MIGRATIONS) await db.query(readFileSync(m, 'utf8'));
      for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));
      await ensureWriteFreezeTenant((s) => db.query(s), TENANT_A);
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source) VALUES ($1::uuid,'core', 'PROVISIONING') ON CONFLICT DO NOTHING`, [TENANT_A]);

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      savedEnv = { DATABASE_URL: process.env['DATABASE_URL'], AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'], AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'], ARAMO_ENV: process.env['ARAMO_ENV'] };
      process.env['DATABASE_URL'] = dburl; process.env['AUTH_AUDIENCE'] = AUDIENCE; process.env['AUTH_PUBLIC_KEY'] = publicPem; process.env['ARAMO_ENV'] = 'itest';
      adminA = await signJwt(kp.privateKey, { sub: ADMIN_A, tenant: TENANT_A, scopes: ['auth:session:read', 'document_template:read', 'document_template:author', 'document_template:manage'] });

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EFFECTIVE_AUTHORIZATION_RESOLVER)
        .useValue(__authzTestResolver)
        .overrideProvider(TEMPLATE_TENANT_LOGO)
        .useValue(stubLogo)
        .compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;
    }, 300_000);

    afterAll(async () => {
      await app?.close(); await db?.end(); await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }, 60_000);

    it('B-2 — allowed-bindings carries data_type, sample_value and active from the catalog (additive; set unchanged)', async () => {
      const { templateId } = await createTemplateWithDraft('Bindings RTR');
      const res = await fetch(url(`/v1/document-templates/${templateId}/allowed-bindings`), auth(adminA));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        bindings: Array<{ key: string; label: string; group: string; data_type: string; sample_value: string | null; active: boolean }>;
        tenant_logo: { available: boolean; tenant_name: string | null };
      };
      expect(body.tenant_logo).toEqual({ available: true, tenant_name: 'Acme Studio Staffing' });
      expect(body.bindings.length).toBeGreaterThan(0);
      const rows = (
        await db.query(`SELECT key, label, group_label, data_type, sample_value, active FROM "documents"."TemplateVariable"`)
      ).rows as Array<{ key: string; label: string; group_label: string; data_type: string; sample_value: string | null; active: boolean }>;
      for (const b of body.bindings) {
        const row = rows.find((r) => r.key === b.key);
        expect(row).toBeDefined();
        expect(b).toEqual({ key: row?.key, label: row?.label, group: row?.group_label, data_type: row?.data_type, sample_value: row?.sample_value, active: true });
        expect(DATA_TYPES).toContain(b.data_type);
      }
      const keys = body.bindings.map((b) => b.key);
      expect(keys).toContain('talent.desired_pay_rate'); // A2
      expect(keys).toContain('requisition.description');
      expect(keys.some((k) => k.startsWith('agreed_pay_rate'))).toBe(false); // A2 :14
      expect(body.bindings.find((b) => b.key === 'requisition.description')?.label).toBe('Job description');
    });

    it('B-1 — a logo-bearing tenant draft saved with Studio-encoded content previews and activates (no logo_asset_mismatch)', async () => {
      const { templateId, versionId } = await createTemplateWithDraft('Studio RTR');
      const cap = await post(`/v1/document-templates/versions/${versionId}/logo`);
      expect(cap.status).toBe(201);
      const assetId = ((await cap.json()) as { asset_id: string }).asset_id;
      const captured = await getVersion(versionId);
      expect(captured.field_schema.html.startsWith(LOGO_NODE)).toBe(true);
      expect(captured.logo?.asset_id).toBe(assetId);

      // The Studio save: the letterhead block encodes back to the first-child node.
      const patch = await patchHtml(versionId, 'Studio RTR', STUDIO_ENCODED_HTML);
      expect(patch.status).toBe(200);
      const saved = await getVersion(versionId);
      expect(saved.field_schema.html).toBe(STUDIO_ENCODED_HTML);
      expect(saved.logo?.asset_id).toBe(assetId); // the server-owned reference is carried over

      const preview = await post(`/v1/document-templates/versions/${versionId}/preview`);
      expect(preview.status).toBe(200);
      expect(((await preview.json()) as { logo: { asset_id: string } | null }).logo).toEqual({ asset_id: assetId });
      const act = await post(`/v1/document-templates/versions/${versionId}/activate`);
      expect(act.status).toBe(200);
      const tpl = (await (await fetch(url(`/v1/document-templates/${templateId}`), auth(adminA))).json()) as { current_version_id: string | null };
      expect(tpl.current_version_id).toBe(versionId);
    });

    it('B-1 removal semantics — content without the node is refused at preview until DELETE /logo clears the reference', async () => {
      const { versionId } = await createTemplateWithDraft('Removal RTR');
      expect((await post(`/v1/document-templates/versions/${versionId}/logo`)).status).toBe(201);

      // Dropping the letterhead from content alone is not a removal: the reference stays and
      // the server (authoritative) refuses the preview and the activation.
      const withoutNode = STUDIO_ENCODED_HTML.slice(LOGO_NODE.length);
      expect((await patchHtml(versionId, 'Removal RTR', withoutNode)).status).toBe(200);
      expect((await getVersion(versionId)).logo).not.toBeNull();
      const bad = await post(`/v1/document-templates/versions/${versionId}/preview`);
      expect(bad.status).toBe(422);
      expect(((await bad.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('logo_asset_mismatch');
      const badAct = await post(`/v1/document-templates/versions/${versionId}/activate`);
      expect(badAct.status).toBe(422);
      expect(((await badAct.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('logo_asset_mismatch');

      // The supported removal: DELETE /logo (reference + node) → preview and activate succeed.
      expect((await fetch(url(`/v1/document-templates/versions/${versionId}/logo`), { method: 'DELETE', ...auth(adminA) })).status).toBe(204);
      const cleared = await getVersion(versionId);
      expect(cleared.logo).toBeNull();
      expect(cleared.field_schema.html.includes('data-asset')).toBe(false);
      expect((await post(`/v1/document-templates/versions/${versionId}/preview`)).status).toBe(200);
      expect((await post(`/v1/document-templates/versions/${versionId}/activate`)).status).toBe(200);
    });
  },
);
