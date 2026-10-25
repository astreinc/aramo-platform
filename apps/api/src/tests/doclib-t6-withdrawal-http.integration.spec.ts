import { randomUUID } from 'node:crypto';
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
import { grantLegacyPlatformSelection } from './helpers/legacy-template-selection.js';

// HF-AUTH-1 — compact tokens carry no scopes; the guard resolves via this resolver.
const __authzTestResolver = new ConfigurableTestResolver();

// DOC-TEMPLATE-LIB-1 T-6 (§9; ADR-0034 D10) — Aramo default withdrawal end-to-end through a
// booted AppModule (real JwtAuthGuard + RolesGuard + consumer_type assertion + the
// TEMPLATE_AUDIT binding to the identity audit ledger):
//   - POST /platform/document-templates/:id/withdraw and …/withdraw/cancel are platform-
//     only (a tenant token and a :read-only platform token are refused; nothing changes)
//   - super_admin publishes a withdrawal (default 7 days), a GLOBAL audit event is written
//     (tenant_id NULL), a second withdrawal / bad notice_days are refused, cancel works
//   - GET /v1/document-templates/notices returns the notice only to tenants that rely on
//     the default, and a platform token cannot read it.
// Migrations: entitlement init + every documents migration (BEFORE identity, so the T-3 RTR
// conversion is a NOTICE no-op and the only defaults are the ones created here) + the
// identity init (IdentityAuditEvent). Skipped unless ARAMO_RUN_INTEGRATION=1.
const ROOT = resolve(__dirname, '../../../..');
const AUDIENCE = 'aramo-doclib-t6-http-spec';
const ALG = 'RS256';
// CCP-A7 — the full entitlement set (the shared helper; the repository reads A7 columns).
const ENTITLEMENT_MIGRATIONS = resolveEntitlementMigrations(ROOT);
const IDENTITY_INIT = resolve(ROOT, 'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql');
function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
const RELYING_TENANT = '01900000-0000-7000-8000-0000000006a1';
const OWN_CHOICE_TENANT = '01900000-0000-7000-8000-0000000006a2';
const OPERATOR = '00000000-0000-7000-8000-0000000006b1';
const TENANT_USER = '00000000-0000-7000-8000-0000000006b2';
const READ = 'platform:document_template:read';
const MANAGE = 'platform:document_template:manage';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'DOC-TEMPLATE-LIB-1 T-6 withdrawal + tenant notices — HTTP (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let superJwt = '';
    let readOnlyJwt = '';
    let relyingJwt = '';
    let ownChoiceJwt = '';
    let typeId = '';
    let templateId = '';

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
    const withdrawState = async (): Promise<{ notice: Date | null; effective: Date | null }> => {
      const r = await db.query(`SELECT withdraw_notice_at, withdraw_effective_at FROM "documents"."DocumentTemplate" WHERE id = $1`, [templateId]);
      return { notice: r.rows[0].withdraw_notice_at, effective: r.rows[0].withdraw_effective_at };
    };
    const auditRows = async (eventType: string) =>
      (
        await db.query(
          `SELECT tenant_id::text, actor_id::text, subject_id::text, event_payload FROM identity."IdentityAuditEvent" WHERE event_type = $1 ORDER BY created_at`,
          [eventType],
        )
      ).rows as Array<{ tenant_id: string | null; actor_id: string; subject_id: string; event_payload: Record<string, unknown> }>;
    const noticesFor = async (jwt: string) => {
      const res = await fetch(url('/v1/document-templates/notices'), auth(jwt));
      expect(res.status).toBe(200);
      return ((await res.json()) as { notices: Array<Record<string, unknown>> }).notices.filter((n) => n['document_type_id'] === typeId);
    };

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const dburl = container.getConnectionUri();
      db = new Client({ connectionString: dburl });
      await db.connect();
      for (const entitlementMigration of ENTITLEMENT_MIGRATIONS) await db.query(readFileSync(entitlementMigration, 'utf8'));
      for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));
      await db.query(readFileSync(IDENTITY_INIT, 'utf8'));
      for (const t of [RELYING_TENANT, OWN_CHOICE_TENANT, PLATFORM_TENANT_SENTINEL_ID]) await ensureWriteFreezeTenant((s) => db.query(s), t);
      for (const t of [RELYING_TENANT, OWN_CHOICE_TENANT]) {
        await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid,'core') ON CONFLICT DO NOTHING`, [t]);
      }

      // A SYSTEM document type with one published Aramo default (ACTIVE version, current).
      typeId = randomUUID();
      templateId = randomUUID();
      const versionId = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentType" (id, tenant_id, key, name, scope, execution_mode_default, retention_class)
         VALUES ($1, NULL, $2, 'T6 type', 'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD')`,
        [typeId, `T6_HTTP_${typeId.slice(0, 8)}`],
      );
      await db.query(
        `INSERT INTO "documents"."DocumentTemplate" (id, owner_scope, tenant_id, document_type_id, name, template_kind, status, products, created_by)
         VALUES ($1,'PLATFORM',NULL,$2,'Aramo T6 default','GENERATED','ACTIVE',ARRAY['SIGN'],$3)`,
        [templateId, typeId, OPERATOR],
      );
      await db.query(
        `INSERT INTO "documents"."TemplateVersion" (id, tenant_id, template_id, version_number, status, render_schema_version, field_schema, created_by, activated_at)
         VALUES ($1,NULL,$2,1,'ACTIVE','v1','{"blocks":[]}'::jsonb,$3,now())`,
        [versionId, templateId, OPERATOR],
      );
      await db.query(`UPDATE "documents"."DocumentTemplate" SET current_version_id = $1 WHERE id = $2`, [versionId, templateId]);
      // ORG-UX-1 §5.3 (T-A) — the relying tenant is on the default through a grandfathered selection.
      await grantLegacyPlatformSelection((q, p) => db.query(q, p), { tenant_id: RELYING_TENANT, document_type_id: typeId, template_id: templateId });
      // OWN_CHOICE_TENANT: its tenant-wide choice is its own approved template.
      const ownTpl = randomUUID();
      const ownVer = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentTemplate" (id, tenant_id, document_type_id, name, template_kind, status, created_by)
         VALUES ($1,$2,$3,'Own','GENERATED','ACTIVE',$4)`,
        [ownTpl, OWN_CHOICE_TENANT, typeId, TENANT_USER],
      );
      await db.query(
        `INSERT INTO "documents"."TemplateVersion" (id, tenant_id, template_id, version_number, status, render_schema_version, field_schema, created_by, activated_at)
         VALUES ($1,$2,$3,1,'ACTIVE','v1','{"blocks":[]}'::jsonb,$4,now())`,
        [ownVer, OWN_CHOICE_TENANT, ownTpl, TENANT_USER],
      );
      await db.query(`UPDATE "documents"."DocumentTemplate" SET current_version_id = $1 WHERE id = $2`, [ownVer, ownTpl]);
      await db.query(
        `INSERT INTO "documents"."TenantTemplateSelection" (id, tenant_id, document_type_id, client_id, template_id, selected_by)
         VALUES ($1,$2,$3,NULL,$4,$5)`,
        [randomUUID(), OWN_CHOICE_TENANT, typeId, ownTpl, TENANT_USER],
      );

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      savedEnv = { DATABASE_URL: process.env['DATABASE_URL'], AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'], AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'], ARAMO_ENV: process.env['ARAMO_ENV'] };
      process.env['DATABASE_URL'] = dburl; process.env['AUTH_AUDIENCE'] = AUDIENCE; process.env['AUTH_PUBLIC_KEY'] = publicPem; process.env['ARAMO_ENV'] = 'itest';
      superJwt = await signJwt(kp.privateKey, { sub: OPERATOR, consumer: 'platform', tenant: PLATFORM_TENANT_SENTINEL_ID, scopes: ['platform:tenant:read', READ, MANAGE] });
      readOnlyJwt = await signJwt(kp.privateKey, { sub: '00000000-0000-7000-8000-0000000006b3', consumer: 'platform', tenant: PLATFORM_TENANT_SENTINEL_ID, scopes: ['platform:tenant:read', READ] });
      // A tenant token even carrying the platform scope strings.
      relyingJwt = await signJwt(kp.privateKey, { sub: TENANT_USER, consumer: 'recruiter', tenant: RELYING_TENANT, scopes: ['document_template:read', 'document_template:manage', READ, MANAGE] });
      ownChoiceJwt = await signJwt(kp.privateKey, { sub: '00000000-0000-7000-8000-0000000006b4', consumer: 'recruiter', tenant: OWN_CHOICE_TENANT, scopes: ['document_template:read'] });

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

    it('withdraw / cancel are platform-only: a tenant token and a :read-only platform token are refused, nothing changes', async () => {
      for (const jwt of [relyingJwt, readOnlyJwt]) {
        const w = await fetch(url(`/platform/document-templates/${templateId}/withdraw`), { method: 'POST', ...auth(jwt), body: JSON.stringify({ notice_days: 7 }) });
        expect([401, 403]).toContain(w.status);
        const c = await fetch(url(`/platform/document-templates/${templateId}/withdraw/cancel`), { method: 'POST', ...auth(jwt) });
        expect([401, 403]).toContain(c.status);
      }
      expect(await withdrawState()).toEqual({ notice: null, effective: null });
      expect(await auditRows('identity.document_template.withdrawal_published')).toHaveLength(0);
    });

    it('no notice before a withdrawal is published', async () => {
      expect(await noticesFor(relyingJwt)).toHaveLength(0);
    });

    it('super_admin publishes a withdrawal (default 7 days) with a GLOBAL audit event; invalid / repeated requests are refused', async () => {
      const bad = await fetch(url(`/platform/document-templates/${templateId}/withdraw`), { method: 'POST', ...auth(superJwt), body: JSON.stringify({ notice_days: 999 }) });
      expect(bad.status).toBe(400);
      const res = await fetch(url(`/platform/document-templates/${templateId}/withdraw`), { method: 'POST', ...auth(superJwt), body: JSON.stringify({ reason: 'Replaced by v2 wording' }) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { withdraw_notice_at: string; withdraw_effective_at: string; products: string[] };
      expect(new Date(body.withdraw_effective_at).getTime() - new Date(body.withdraw_notice_at).getTime()).toBe(7 * 86_400_000);
      expect(body.products).toEqual(['SIGN']);
      const rows = await auditRows('identity.document_template.withdrawal_published');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tenant_id: null, actor_id: OPERATOR, subject_id: templateId });
      expect(rows[0]?.event_payload).toMatchObject({ template_id: templateId, document_type_id: typeId, notice_days: 7, reason: 'Replaced by v2 wording' });

      const again = await fetch(url(`/platform/document-templates/${templateId}/withdraw`), { method: 'POST', ...auth(superJwt), body: '{}' });
      expect(again.status).toBe(409);
      const err = (await again.json()) as { error: { code: string; details: { reason: string } } };
      expect(err.error.code).toBe('TEMPLATE_PLATFORM_DEFAULT_CONFLICT');
      expect(err.error.details.reason).toBe('already_withdrawn');
    });

    it('notices: the relying tenant sees it (tags never filter), a tenant with its own choice does not, a platform token cannot read it', async () => {
      const relying = await noticesFor(relyingJwt);
      expect(relying).toHaveLength(1);
      expect(relying[0]).toMatchObject({
        template_id: templateId,
        status: 'PENDING',
        relies_on_default: true,
        selected_for_client_ids: [null],
        has_own_template: false,
        products: ['SIGN'],
      });
      expect(await noticesFor(ownChoiceJwt)).toHaveLength(0);
      expect([401, 403]).toContain((await fetch(url('/v1/document-templates/notices'), auth(superJwt))).status);
    });

    it('cancel before the effective date clears the withdrawal, audits it, and the notice disappears', async () => {
      const res = await fetch(url(`/platform/document-templates/${templateId}/withdraw/cancel`), { method: 'POST', ...auth(superJwt) });
      expect(res.status).toBe(200);
      expect(await withdrawState()).toEqual({ notice: null, effective: null });
      const rows = await auditRows('identity.document_template.withdrawal_cancelled');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tenant_id: null, actor_id: OPERATOR, subject_id: templateId });
      expect(await noticesFor(relyingJwt)).toHaveLength(0);
      const again = await fetch(url(`/platform/document-templates/${templateId}/withdraw/cancel`), { method: 'POST', ...auth(superJwt) });
      expect(again.status).toBe(409);
    });

    it('a withdrawal already in effect cannot be cancelled', async () => {
      const res = await fetch(url(`/platform/document-templates/${templateId}/withdraw`), { method: 'POST', ...auth(superJwt), body: JSON.stringify({ notice_days: 0 }) });
      expect(res.status).toBe(200);
      const c = await fetch(url(`/platform/document-templates/${templateId}/withdraw/cancel`), { method: 'POST', ...auth(superJwt) });
      expect(c.status).toBe(409);
      expect(((await c.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('withdrawal_in_effect');
      const n = await noticesFor(relyingJwt);
      expect(n[0]).toMatchObject({ status: 'IN_EFFECT' });
    });
  },
);
