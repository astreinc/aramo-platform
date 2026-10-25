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

import { AppModule } from '../app.module.js';

import { ConfigurableTestResolver } from './support/test-auth-harness.js';
import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

const __authzTestResolver = new ConfigurableTestResolver();

// DOC-TEMPLATE-LIB-1 T-4 — Implementation Directive v1.0 (LOCKED) §8.2 / §6.2 (ADR-0034
// D3, D4, D5, D6, D8): the Org Home template library through a booted AppModule (real
// JwtAuthGuard + EntitlementGuard + RolesGuard, org-consumer tokens). Proves:
//   - the gallery is the tenant's own templates ∪ the resolvable Aramo defaults (current
//     version only, "Updated" date), never another tenant's templates;
//   - an Aramo default previews with the tenant's branding and writes nothing;
//   - "Create your own document template" creates an ordinary TENANT template with no copy
//     and no link to a default (an unknown copy field is ignored);
//   - no tenant route can write a PLATFORM row (every write path is 404, rows unchanged);
//   - selection set / clear (approval switches it; clear reverts to the Aramo default);
//   - read-only holders cannot change a selection.
// Skipped unless ARAMO_RUN_INTEGRATION=1.
const ROOT = resolve(__dirname, '../../../..');
const AUDIENCE = 'aramo-doclib-t4-http-spec';
const ALG = 'RS256';
// CCP-A7 — the full entitlement set (the shared helper; the repository reads A7 columns).
const ENTITLEMENT_MIGRATIONS = resolveEntitlementMigrations(ROOT);
function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
const TENANT_A = '01900000-0000-7000-8000-0000000000e4';
const TENANT_B = '01900000-0000-7000-8000-0000000000e5';
const ADMIN_A = '00000000-0000-7000-8000-00000000e4a1';
const READER_A = '00000000-0000-7000-8000-00000000e4a2';
const ADMIN_B = '00000000-0000-7000-8000-00000000e5b1';
const RTR = 'd0c50005-0000-7000-8000-000000000001';
const HTML_SCHEMA = 'rtr-html-v1';

interface LibraryItem {
  id: string;
  owner_scope: string;
  document_type_id: string;
  current_version_id: string | null;
  current_version_number: number | null;
  updated_at: string;
  products: string[] | null;
  configurable: boolean;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'DOC-TEMPLATE-LIB-1 T-4 tenant template library — HTTP (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let adminA = '';
    let readerA = '';
    let adminB = '';
    let defaultId = '';
    let defaultVersionId = '';
    let ownId = '';
    let ownVersionId = '';

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
    const platformSnapshot = async (): Promise<string> =>
      JSON.stringify([
        (await db.query(`SELECT * FROM "documents"."DocumentTemplate" WHERE owner_scope = 'PLATFORM' ORDER BY id`)).rows,
        (await db.query(`SELECT * FROM "documents"."TemplateVersion" WHERE tenant_id IS NULL ORDER BY id`)).rows,
      ]);
    async function library(jwt: string): Promise<{ items: LibraryItem[]; document_types: Array<{ id: string; configurable: boolean }> }> {
      const res = await fetch(url('/v1/document-templates/library'), auth(jwt));
      expect(res.status).toBe(200);
      return (await res.json()) as { items: LibraryItem[]; document_types: Array<{ id: string; configurable: boolean }> };
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const dburl = container.getConnectionUri();
      db = new Client({ connectionString: dburl });
      await db.connect();
      // The identity schema first (the branding read selects the profile columns); no
      // platform sentinel row, so the T-3 conversion creates the Aramo RTR default.
      for (const p of resolveIdentityMigrations(ROOT)) await db.query(readFileSync(p, 'utf8'));
      for (const entitlementMigration of ENTITLEMENT_MIGRATIONS) await db.query(readFileSync(entitlementMigration, 'utf8'));
      for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));
      for (const t of [TENANT_A, TENANT_B]) {
        await ensureWriteFreezeTenant((s) => db.query(s), t);
        await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid,'core') ON CONFLICT DO NOTHING`, [t]);
      }
      await db.query(
        `UPDATE identity."Tenant" SET display_name = 'Acme Branded Staffing', city = 'Springfield' WHERE id = $1`,
        [TENANT_A],
      );
      const def = await db.query(
        `SELECT id::text, current_version_id::text FROM "documents"."DocumentTemplate" WHERE owner_scope = 'PLATFORM' AND document_type_id = $1`,
        [RTR],
      );
      expect(def.rows).toHaveLength(1);
      defaultId = def.rows[0].id;
      defaultVersionId = def.rows[0].current_version_id;

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      savedEnv = { DATABASE_URL: process.env['DATABASE_URL'], AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'], AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'], ARAMO_ENV: process.env['ARAMO_ENV'] };
      process.env['DATABASE_URL'] = dburl; process.env['AUTH_AUDIENCE'] = AUDIENCE; process.env['AUTH_PUBLIC_KEY'] = publicPem; process.env['ARAMO_ENV'] = 'itest';
      // The org session carries the organization set + document_template:{read,manage} (§6.2).
      adminA = await signJwt(kp.privateKey, { sub: ADMIN_A, tenant: TENANT_A, scopes: ['auth:session:read', 'tenant:admin:profile', 'document_template:read', 'document_template:author', 'document_template:manage'] });
      readerA = await signJwt(kp.privateKey, { sub: READER_A, tenant: TENANT_A, scopes: ['auth:session:read', 'document_template:read'] });
      adminB = await signJwt(kp.privateKey, { sub: ADMIN_B, tenant: TENANT_B, scopes: ['auth:session:read', 'document_template:read', 'document_template:author', 'document_template:manage'] });

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EFFECTIVE_AUTHORIZATION_RESOLVER)
        .useValue(__authzTestResolver).compile();
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

    it('gallery — the Aramo RTR default (current version, Updated date, product tags) with no tenant templates yet', async () => {
      const lib = await library(adminA);
      const def = lib.items.find((i) => i.id === defaultId);
      expect(def?.owner_scope).toBe('PLATFORM');
      expect(def?.current_version_id).toBe(defaultVersionId);
      expect(def?.current_version_number).toBeGreaterThanOrEqual(1);
      expect(Number.isNaN(Date.parse(def?.updated_at ?? ''))).toBe(false);
      expect(Array.isArray(def?.products)).toBe(true);
      expect(def?.configurable).toBe(true);
      expect(lib.items.filter((i) => i.owner_scope === 'TENANT')).toHaveLength(0);
      expect(lib.document_types.find((d) => d.id === RTR)?.configurable).toBe(true);
    });

    it('default preview — rendered with the tenant branding; read-only (nothing written)', async () => {
      const before = await platformSnapshot();
      const res = await fetch(url(`/v1/document-templates/library/${defaultId}/preview`), auth(readerA));
      expect(res.status).toBe(200);
      const p = (await res.json()) as {
        version_id: string;
        letterhead: { organization_name: string | null; logo_available: boolean };
        sample_values: Array<{ key: string; value: string }>;
      };
      expect(p.version_id).toBe(defaultVersionId);
      expect(p.letterhead).toEqual({ organization_name: 'Acme Branded Staffing', logo_available: false });
      const orgName = p.sample_values.find((v) => v.key === 'organization.name');
      if (orgName !== undefined) expect(orgName.value).toBe('Acme Branded Staffing');
      const city = p.sample_values.find((v) => v.key === 'organization.city');
      if (city !== undefined) expect(city.value).toBe('Springfield');
      expect(await platformSnapshot()).toBe(before);
      // Tenant B sees its own (empty) branding on the same default.
      const pb = (await (await fetch(url(`/v1/document-templates/library/${defaultId}/preview`), auth(adminB))).json()) as {
        letterhead: { organization_name: string | null };
      };
      expect(pb.letterhead.organization_name).not.toBe('Acme Branded Staffing');
    });

    it('create your own — an ordinary TENANT template: no copy, no link to a default', async () => {
      const res = await fetch(url('/v1/document-templates'), {
        method: 'POST',
        ...auth(adminA),
        // A copy field is not part of the contract: ignored, never stored.
        body: JSON.stringify({ document_type_id: RTR, name: 'Our RTR', template_kind: 'GENERATED', copy_from_template_id: defaultId }),
      });
      expect(res.status).toBe(201);
      const tpl = (await res.json()) as Record<string, unknown>;
      ownId = tpl['id'] as string;
      expect(tpl['owner_scope']).toBe('TENANT');
      expect(tpl['tenant_id']).toBe(TENANT_A);
      expect(tpl['current_version_id']).toBeNull();
      expect(JSON.stringify(tpl)).not.toContain(defaultId);
      // No version exists until the admin writes one from scratch.
      expect((await db.query(`SELECT count(*)::int c FROM "documents"."TemplateVersion" WHERE template_id = $1`, [ownId])).rows[0].c).toBe(0);
      const v = await fetch(url(`/v1/document-templates/${ownId}/versions`), {
        method: 'POST',
        ...auth(adminA),
        body: JSON.stringify({ render_schema_version: HTML_SCHEMA, field_schema: { render_schema_version: HTML_SCHEMA, title: 'Our RTR', html: '' } }),
      });
      expect(v.status).toBe(201);
      ownVersionId = ((await v.json()) as { id: string }).id;
      const lib = await library(adminA);
      expect(lib.items.find((i) => i.id === ownId)?.owner_scope).toBe('TENANT');
    });

    it('no tenant route can write a PLATFORM row (every write path is 404; rows unchanged)', async () => {
      const before = await platformSnapshot();
      const html = JSON.stringify({ field_schema: { render_schema_version: HTML_SCHEMA, title: 'X', html: '<p>x</p>' } });
      for (const [method, path, body] of [
        ['PATCH', `/v1/document-templates/${defaultId}`, JSON.stringify({ name: 'Hijacked' })],
        ['POST', `/v1/document-templates/${defaultId}/draft`, undefined],
        ['POST', `/v1/document-templates/${defaultId}/versions`, JSON.stringify({ render_schema_version: HTML_SCHEMA })],
        ['PATCH', `/v1/document-templates/versions/${defaultVersionId}`, html],
        ['POST', `/v1/document-templates/versions/${defaultVersionId}/preview`, undefined],
        ['POST', `/v1/document-templates/versions/${defaultVersionId}/activate`, undefined],
        ['DELETE', `/v1/document-templates/versions/${defaultVersionId}`, undefined],
        ['POST', `/v1/document-templates/versions/${defaultVersionId}/logo`, undefined],
        ['DELETE', `/v1/document-templates/versions/${defaultVersionId}/logo`, undefined],
        ['POST', `/v1/document-templates/versions/${defaultVersionId}/fields`, JSON.stringify({ field_key: 'k', field_type: 'TEXT', ordinal: 1 })],
      ] as const) {
        const res = await fetch(url(path), { method, ...auth(adminA), ...(body !== undefined ? { body } : {}) });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
      expect(await platformSnapshot()).toBe(before);
    });

    // ORG-UX-1 §5.3 — an Aramo default is never selected directly (adopt it instead).
    it('selection — an unapproved own template is refused; approval switches it; the default is not selectable; clear empties', async () => {
      const draftSel = await fetch(url('/v1/document-templates/selections'), {
        method: 'PUT',
        ...auth(adminA),
        body: JSON.stringify({ document_type_id: RTR, template_id: ownId }),
      });
      expect(draftSel.status).toBe(422);
      expect(((await draftSel.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('template_not_active');

      // Write content, preview, approve (the same person may approve — D6).
      const patch = await fetch(url(`/v1/document-templates/versions/${ownVersionId}`), {
        method: 'PATCH',
        ...auth(adminA),
        body: JSON.stringify({ field_schema: { render_schema_version: HTML_SCHEMA, title: 'Our RTR', html: '<p>We represent <span data-field="talent.full_name"></span>.</p>' } }),
      });
      expect(patch.status).toBe(200);
      expect((await fetch(url(`/v1/document-templates/versions/${ownVersionId}/preview`), { method: 'POST', ...auth(adminA) })).status).toBe(200);
      expect((await fetch(url(`/v1/document-templates/versions/${ownVersionId}/activate`), { method: 'POST', ...auth(adminA) })).status).toBe(200);
      let sel = (await (await fetch(url('/v1/document-templates/selections'), auth(readerA))).json()) as { items: Array<{ template_id: string; client_id: string | null }> };
      expect(sel.items).toEqual([expect.objectContaining({ template_id: ownId, client_id: null })]);

      const toDefault = await fetch(url('/v1/document-templates/selections'), {
        method: 'PUT',
        ...auth(adminA),
        body: JSON.stringify({ document_type_id: RTR, client_id: null, template_id: defaultId }),
      });
      expect(toDefault.status).toBe(422);
      expect(((await toDefault.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('platform_template_not_selectable');

      expect((await fetch(url(`/v1/document-templates/selections?document_type_id=${RTR}`), { method: 'DELETE', ...auth(adminA) })).status).toBe(204);
      sel = (await (await fetch(url('/v1/document-templates/selections'), auth(adminA))).json()) as { items: Array<{ template_id: string; client_id: string | null }> };
      expect(sel.items).toEqual([]);
      // Idempotent clear.
      expect((await fetch(url(`/v1/document-templates/selections?document_type_id=${RTR}`), { method: 'DELETE', ...auth(adminA) })).status).toBe(204);
    });

    // ORG-UX-1 §5.1 (Lead Correction B) — adopt over HTTP: an independent tenant draft with
    // audit-only provenance; nothing resolves until approved; a reader cannot adopt.
    it('adopt — POST /v1/document-templates/adopt creates an independent tenant DRAFT with provenance; readers are refused', async () => {
      const res = await fetch(url('/v1/document-templates/adopt'), {
        method: 'POST',
        ...auth(adminB),
        body: JSON.stringify({ library_template_id: defaultId }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { template: Record<string, unknown>; version: Record<string, unknown> };
      expect(body.template).toMatchObject({ owner_scope: 'TENANT', status: 'DRAFT', document_type_id: RTR, adopted_from_template_id: defaultId });
      expect(body.version).toMatchObject({ status: 'DRAFT', version_number: 1 });
      expect((await fetch(url('/v1/document-templates/adopt'), { method: 'POST', ...auth(readerA), body: JSON.stringify({ library_template_id: defaultId }) })).status).toBe(403);
      expect(
        (await fetch(url('/v1/document-templates/adopt'), { method: 'POST', ...auth(adminB), body: JSON.stringify({ library_template_id: ownId }) })).status,
      ).toBe(404);
    });

    it('read-only holders read the gallery but cannot change a selection (403)', async () => {
      await library(readerA);
      const put = await fetch(url('/v1/document-templates/selections'), {
        method: 'PUT',
        ...auth(readerA),
        body: JSON.stringify({ document_type_id: RTR, template_id: defaultId }),
      });
      expect(put.status).toBe(403);
      expect((await fetch(url(`/v1/document-templates/selections?document_type_id=${RTR}`), { method: 'DELETE', ...auth(readerA) })).status).toBe(403);
    });

    it('no cross-tenant — tenant B never sees, previews or selects tenant A templates', async () => {
      const lib = await library(adminB);
      expect(lib.items.map((i) => i.id)).not.toContain(ownId);
      expect(lib.items.map((i) => i.id)).toContain(defaultId);
      expect((await fetch(url(`/v1/document-templates/library/${ownId}/preview`), auth(adminB))).status).toBe(404);
      // A tenant template is not an Aramo default: 404 on the default preview, even for its owner.
      expect((await fetch(url(`/v1/document-templates/library/${ownId}/preview`), auth(adminA))).status).toBe(404);
      const put = await fetch(url('/v1/document-templates/selections'), {
        method: 'PUT',
        ...auth(adminB),
        body: JSON.stringify({ document_type_id: RTR, template_id: ownId }),
      });
      expect(put.status).toBe(404);
      const sel = (await (await fetch(url('/v1/document-templates/selections'), auth(adminB))).json()) as { items: unknown[] };
      expect(sel.items).toEqual([]);
    });
  },
);
