import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
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

// HF-AUTH-1 — compact tokens carry no scopes; the guard resolves via this resolver.
const __authzTestResolver = new ConfigurableTestResolver();

// DOC-TEMPLATE-LIB-1 T-2 (§6.1) — the platform template routes end-to-end through a booted
// AppModule (real JwtAuthGuard tier check + RolesGuard + the controller's consumer_type
// assertion): a tenant token is refused on /platform/document-templates*, a platform token
// without platform:document_template:* is refused, :read cannot write, and super_admin's
// full grant can create → draft → (preview gate) → publish. The tenant route cannot see
// the PLATFORM row. Skipped unless ARAMO_RUN_INTEGRATION=1.
const ROOT = resolve(__dirname, '../../../..');
const AUDIENCE = 'aramo-doclib-t2-http-spec';
const ALG = 'RS256';
const ENTITLEMENT_INIT = resolve(ROOT, 'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql');
function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
const TENANT = '01900000-0000-7000-8000-0000000000d2';
const OPERATOR = '00000000-0000-7000-8000-00000000d2a1';
const TENANT_ADMIN = '00000000-0000-7000-8000-00000000d2b1';
const RTR = 'd0c50005-0000-7000-8000-000000000001';
const READ = 'platform:document_template:read';
const MANAGE = 'platform:document_template:manage';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'DOC-TEMPLATE-LIB-1 T-2 platform template routes — HTTP authz (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let superJwt = '';
    let readOnlyJwt = '';
    let otherPlatformJwt = '';
    let tenantJwt = '';

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
    const platformCount = async (): Promise<number> =>
      Number((await db.query(`SELECT count(*)::int c FROM "documents"."DocumentTemplate" WHERE owner_scope = 'PLATFORM'`)).rows[0].c);

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const dburl = container.getConnectionUri();
      db = new Client({ connectionString: dburl });
      await db.connect();
      await db.query(readFileSync(ENTITLEMENT_INIT, 'utf8'));
      for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));
      await ensureWriteFreezeTenant((s) => db.query(s), TENANT);
      await ensureWriteFreezeTenant((s) => db.query(s), PLATFORM_TENANT_SENTINEL_ID);
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid,'core') ON CONFLICT DO NOTHING`, [TENANT]);

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      savedEnv = { DATABASE_URL: process.env['DATABASE_URL'], AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'], AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'], ARAMO_ENV: process.env['ARAMO_ENV'] };
      process.env['DATABASE_URL'] = dburl; process.env['AUTH_AUDIENCE'] = AUDIENCE; process.env['AUTH_PUBLIC_KEY'] = publicPem; process.env['ARAMO_ENV'] = 'itest';
      superJwt = await signJwt(kp.privateKey, { sub: OPERATOR, consumer: 'platform', tenant: PLATFORM_TENANT_SENTINEL_ID, scopes: ['platform:tenant:read', READ, MANAGE] });
      readOnlyJwt = await signJwt(kp.privateKey, { sub: '00000000-0000-7000-8000-00000000d2a2', consumer: 'platform', tenant: PLATFORM_TENANT_SENTINEL_ID, scopes: ['platform:tenant:read', READ] });
      otherPlatformJwt = await signJwt(kp.privateKey, { sub: '00000000-0000-7000-8000-00000000d2a3', consumer: 'platform', tenant: PLATFORM_TENANT_SENTINEL_ID, scopes: ['platform:tenant:read', 'platform:skill:manage'] });
      tenantJwt = await signJwt(kp.privateKey, { sub: TENANT_ADMIN, consumer: 'recruiter', tenant: TENANT, scopes: ['document_template:read', 'document_template:manage', READ, MANAGE] });

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EFFECTIVE_AUTHORIZATION_RESOLVER)
        .useValue(__authzTestResolver).compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;
    }, 240_000);

    afterAll(async () => {
      await app?.close(); await db?.end(); await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }, 60_000);

    const CREATE = JSON.stringify({ document_type_id: RTR, name: 'Aramo standard RTR', template_kind: 'GENERATED', products: ['ATS'] });

    it('a tenant token (even one carrying platform:* strings) is refused on every platform template route', async () => {
      const before = await platformCount();
      for (const [method, path, body] of [
        ['GET', '/platform/document-templates', undefined],
        ['POST', '/platform/document-templates', CREATE],
        ['GET', '/platform/template-variables', undefined],
        ['POST', '/platform/template-variables', JSON.stringify({ key: 'a.b', label: 'L', group_label: 'G', data_type: 'TEXT' })],
      ] as const) {
        const res = await fetch(url(path), { method, ...auth(tenantJwt), ...(body !== undefined ? { body } : {}) });
        expect([401, 403], `${method} ${path}`).toContain(res.status);
      }
      expect(await platformCount()).toBe(before);
    });

    it('a platform token without platform:document_template:* is refused (403)', async () => {
      expect((await fetch(url('/platform/document-templates'), auth(otherPlatformJwt))).status).toBe(403);
      expect((await fetch(url('/platform/template-variables'), auth(otherPlatformJwt))).status).toBe(403);
    });

    it(':read lists but cannot write (403, nothing written)', async () => {
      expect((await fetch(url('/platform/document-templates'), auth(readOnlyJwt))).status).toBe(200);
      const before = await platformCount();
      const res = await fetch(url('/platform/document-templates'), { method: 'POST', ...auth(readOnlyJwt), body: CREATE });
      expect(res.status).toBe(403);
      expect(await platformCount()).toBe(before);
    });

    it('super_admin creates → drafts → is held by the preview gate → previews → publishes; the tenant route cannot see the default', async () => {
      const created = await fetch(url('/platform/document-templates'), { method: 'POST', ...auth(superJwt), body: CREATE });
      expect(created.status).toBe(201);
      const tpl = (await created.json()) as { id: string; owner_scope: string };
      expect(tpl.owner_scope).toBe('PLATFORM');

      const draftRes = await fetch(url(`/platform/document-templates/${tpl.id}/versions`), {
        method: 'POST',
        ...auth(superJwt),
        body: JSON.stringify({
          render_schema_version: 'rtr-html-v1',
          field_schema: { render_schema_version: 'rtr-html-v1', title: 'Right to Represent', html: '<p>Represent <span data-field="talent.full_name"></span></p>' },
        }),
      });
      expect(draftRes.status).toBe(201);
      const draft = (await draftRes.json()) as { id: string };

      const early = await fetch(url(`/platform/document-templates/versions/${draft.id}/publish`), { method: 'POST', ...auth(superJwt) });
      expect(early.status).toBe(409);
      expect(((await early.json()) as { error: { code: string } }).error.code).toBe('TEMPLATE_PREVIEW_REQUIRED');

      expect((await fetch(url(`/platform/document-templates/versions/${draft.id}/preview`), { method: 'POST', ...auth(superJwt) })).status).toBe(200);
      const pub = await fetch(url(`/platform/document-templates/versions/${draft.id}/publish`), { method: 'POST', ...auth(superJwt) });
      expect(pub.status).toBe(200);
      expect(((await pub.json()) as { status: string }).status).toBe('ACTIVE');

      // The tenant route cannot see the PLATFORM row; a platform token cannot use the tenant route.
      expect((await fetch(url(`/v1/document-templates/${tpl.id}`), auth(tenantJwt))).status).toBe(404);
      const tenantList = (await (await fetch(url('/v1/document-templates'), auth(tenantJwt))).json()) as Array<{ id: string }>;
      expect(tenantList.map((t) => t.id)).not.toContain(tpl.id);
      expect([401, 403]).toContain((await fetch(url('/v1/document-templates'), auth(superJwt))).status);
    });
  },
);
