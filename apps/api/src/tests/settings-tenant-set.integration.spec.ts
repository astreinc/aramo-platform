import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  exportSPKI,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type KeyObject,
} from 'jose';

import { AppModule } from '../app.module.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

// Settings S2 — the endpoint-level §4.1 proofs (the four-axis closed-set-at-
// write security property + the audit two-call seam).
//
// Endpoint-level proofs (covered here):
//   (e) bad value           → VALIDATION_ERROR with details.reason
//                              ('invalid_value') + allowed-set
//   (f) unknown key         → VALIDATION_ERROR at the controller boundary
//                              with details.reason='unknown_key'
//   (g) the write emits identity.tenant_setting.updated with
//       {key, value, previous_value}
//   (h) the endpoint gated on tenant:admin:settings (403/401)
//   (i) per-tenant isolation — tenant A's set invisible to tenant B
//
// Substrate proofs (covered by libs/settings/src/tests/settings.integration.spec.ts):
//   (a) the model migrates
//   (b) the typed-accessor registers + lights up
//   (c) set + get round-trips (first-set returns previous_value: null;
//                              re-set captures prior value)
//   (d) no-row tenant returns the default

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');

const IDENTITY_INIT = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
);
// Domain-Enforcement P1 — additive Tenant.allowed_domain column.
const IDENTITY_ALLOWED_DOMAIN = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260625000000_add_tenant_allowed_domain/migration.sql',
);
// Domain-Enforcement P2b — additive Tenant domain-verification columns.
const IDENTITY_DOMAIN_VERIFICATION = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260626000000_add_tenant_domain_verification/migration.sql',
);
const IDENTITY_SLUG = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260626120000_add_tenant_slug/migration.sql',
);
// Subdomain-Identity Directive B — additive Tenant.identity_provider column.
const IDENTITY_IDP = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260627000000_add_tenant_identity_provider/migration.sql',
);
const IDENTITY_IDP_LC = resolve(ROOT, 'libs/identity/prisma/migrations/20260709130000_add_tenant_lifecycle_status/migration.sql');
const IDENTITY_INVITATION_MIG = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260624000000_add_invitation_and_invite_status/migration.sql',
);
// Settings Rebuild D3 — additive tenant-profile columns (Prisma SELECTs them).
const IDENTITY_PROFILE = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260619000000_add_tenant_profile/migration.sql',
);
const ENTITLEMENT_INIT = resolve(
  ROOT,
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
);
const SETTINGS_INIT = resolve(
  ROOT,
  'libs/settings/prisma/migrations/20260605000000_init_settings_model/migration.sql',
);

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-settings-s2-spec';
const ALG = 'RS256';

const TENANT_A = '11111111-0000-7000-8000-aaaaaaaaaaaa';
const TENANT_B = '22222222-0000-7000-8000-bbbbbbbbbbbb';
const TENANT_ADMIN_A_SUB = '00000000-0000-7000-8000-aaaaaaaaaaa1';
const TENANT_ADMIN_B_SUB = '00000000-0000-7000-8000-bbbbbbbbbbb1';
const RECRUITER_SUB = '00000000-0000-7000-8000-aaaaaaaaaaa2';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Settings S2 — PUT /v1/tenant/settings/:key endpoint proofs',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    const savedEnv: Partial<Record<string, string | undefined>> = {};
    let setupClient: Client;
    let tenantAdminAJwt: string;
    let tenantAdminBJwt: string;
    let recruiterJwt: string;

    async function signJwt(
      privateKey: SignKey,
      args: { sub: string; tenant_id: string; scopes: string[] },
    ): Promise<string> {
      const builder = new SignJWT({
        sub: args.sub,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: args.tenant_id,
        scopes: args.scopes,
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h');
      return builder.sign(privateKey);
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      setupClient = new Client({ connectionString: url });
      await setupClient.connect();

      // Migrations the endpoint touches:
      //   - entitlement  → @RequireCapability('core') gate
      //   - settings     → TenantSettingService read+write
      //   - identity     → IdentityAuditEvent (the audit two-call seam)
      for (const p of [IDENTITY_INIT, IDENTITY_ALLOWED_DOMAIN, IDENTITY_DOMAIN_VERIFICATION, IDENTITY_SLUG, IDENTITY_IDP, IDENTITY_IDP_LC, IDENTITY_INVITATION_MIG, IDENTITY_PROFILE, ENTITLEMENT_INIT, SETTINGS_INIT]) {
        await setupClient.query(readFileSync(p, 'utf8'));
      }

      // Inc-3 PR-3.7 — the global write-freeze interceptor reads identity.Tenant
      // status on every mutation; seed an ACTIVE tenant for each forged tenant_id.
      await ensureWriteFreezeTenant((s) => setupClient.query(s), TENANT_A);
      await ensureWriteFreezeTenant((s) => setupClient.query(s), TENANT_B);

      // Entitle both tenants with `core` (the baseline tenant capability).
      for (const tenant of [TENANT_A, TENANT_B]) {
        await setupClient.query(
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
           VALUES ($1::uuid, 'core')
           ON CONFLICT (tenant_id, capability) DO NOTHING`,
          [tenant],
        );
      }

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      const privateKey: SignKey = kp.privateKey as SignKey;

      savedEnv['DATABASE_URL'] = process.env['DATABASE_URL'];
      savedEnv['AUTH_AUDIENCE'] = process.env['AUTH_AUDIENCE'];
      savedEnv['AUTH_PUBLIC_KEY'] = process.env['AUTH_PUBLIC_KEY'];
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;

      tenantAdminAJwt = await signJwt(privateKey, {
        sub: TENANT_ADMIN_A_SUB,
        tenant_id: TENANT_A,
        scopes: ['tenant:admin:settings'],
      });
      tenantAdminBJwt = await signJwt(privateKey, {
        sub: TENANT_ADMIN_B_SUB,
        tenant_id: TENANT_B,
        scopes: ['tenant:admin:settings'],
      });
      recruiterJwt = await signJwt(privateKey, {
        sub: RECRUITER_SUB,
        tenant_id: TENANT_A,
        scopes: ['requisition:read', 'company:read'],
      });

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }),
      );
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;
    }, 240_000);

    afterAll(async () => {
      await app?.close();
      await setupClient?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    // -----------------------------------------------------------------------
    // proof (g) — the write path round-trips + the audit event commits
    // -----------------------------------------------------------------------
    it('200 — first-set returns {key, value, previous_value: null} + emits identity.tenant_setting.updated', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/tenant/settings/compensation.display_default`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${tenantAdminAJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ value: 'spread' }),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        key: 'compensation.display_default',
        value: 'spread',
        previous_value: null,
      });

      // The setting row exists with last_modified_by = the JWT sub.
      const setting = await setupClient.query(
        `SELECT value, last_modified_by FROM settings."TenantSetting"
         WHERE tenant_id = $1 AND key = $2`,
        [TENANT_A, 'compensation.display_default'],
      );
      expect(setting.rows).toHaveLength(1);
      expect(setting.rows[0]?.value).toBe('spread');
      expect(setting.rows[0]?.last_modified_by).toBe(TENANT_ADMIN_A_SUB);

      // The audit event committed with the {key, value, previous_value}
      // payload + the correct tenant scope + actor. subject_id is the
      // tenant_id (the @db.Uuid column cannot carry the string setting
      // key — the key lives in the payload), so the WHERE filters on
      // (event_type, tenant_id, payload->>'key') instead.
      const audit = await setupClient.query(
        `SELECT tenant_id, actor_id, event_type, subject_id, event_payload
         FROM identity."IdentityAuditEvent"
         WHERE event_type = $1
           AND tenant_id = $2
           AND event_payload->>'key' = $3`,
        [
          'identity.tenant_setting.updated',
          TENANT_A,
          'compensation.display_default',
        ],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]?.actor_id).toBe(TENANT_ADMIN_A_SUB);
      expect(audit.rows[0]?.subject_id).toBe(TENANT_A);
      expect(audit.rows[0]?.event_payload).toEqual({
        key: 'compensation.display_default',
        value: 'spread',
        previous_value: null,
      });
    });

    it('200 — re-set returns the prior value as previous_value', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/tenant/settings/compensation.display_default`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${tenantAdminAJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ value: 'markup' }),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        key: 'compensation.display_default',
        value: 'markup',
        previous_value: 'spread',
      });
    });

    // -----------------------------------------------------------------------
    // proof (e) — bad value → VALIDATION_ERROR; DB unchanged
    // -----------------------------------------------------------------------
    it('400 — invalid value rejected with VALIDATION_ERROR details.reason=invalid_value', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/tenant/settings/compensation.display_default`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${tenantAdminAJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ value: 'margin_percent' }),
        },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details).toMatchObject({
        reason: 'invalid_value',
        key: 'compensation.display_default',
      });

      // DB unchanged — the prior 'markup' value still on the row.
      const setting = await setupClient.query(
        `SELECT value FROM settings."TenantSetting"
         WHERE tenant_id = $1 AND key = $2`,
        [TENANT_A, 'compensation.display_default'],
      );
      expect(setting.rows[0]?.value).toBe('markup');
    });

    // -----------------------------------------------------------------------
    // proof (f) — unknown key → VALIDATION_ERROR at the controller boundary
    // -----------------------------------------------------------------------
    it('400 — unknown key rejected with VALIDATION_ERROR details.reason=unknown_key + allowed_keys', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/tenant/settings/this.is.not.a.known.key`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${tenantAdminAJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ value: 'whatever' }),
        },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details).toMatchObject({
        reason: 'unknown_key',
        key: 'this.is.not.a.known.key',
      });
      expect(body.error.details['allowed_keys']).toContain(
        'compensation.display_default',
      );
    });

    // -----------------------------------------------------------------------
    // proof (h) — the scope-gate (403/401)
    // -----------------------------------------------------------------------
    it('403 — recruiter (lacking tenant:admin:settings) is rejected by the scope-gate', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/tenant/settings/compensation.display_default`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${recruiterJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ value: 'spread' }),
        },
      );
      expect(res.status).toBe(403);
    });

    it('401 — missing bearer token is rejected by JwtAuthGuard', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/tenant/settings/compensation.display_default`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: 'spread' }),
        },
      );
      expect(res.status).toBe(401);
    });

    // -----------------------------------------------------------------------
    // proof (i) — per-tenant isolation on the write path
    // -----------------------------------------------------------------------
    it('per-tenant isolation — tenant B writes a separate row; tenant A is unaffected', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/tenant/settings/compensation.display_default`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${tenantAdminBJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ value: 'both' }),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // Tenant B's first-set — previous_value: null even though tenant
      // A already has a row for the same key.
      expect(body).toEqual({
        key: 'compensation.display_default',
        value: 'both',
        previous_value: null,
      });

      const a = await setupClient.query(
        `SELECT value FROM settings."TenantSetting"
         WHERE tenant_id = $1 AND key = $2`,
        [TENANT_A, 'compensation.display_default'],
      );
      const b = await setupClient.query(
        `SELECT value FROM settings."TenantSetting"
         WHERE tenant_id = $1 AND key = $2`,
        [TENANT_B, 'compensation.display_default'],
      );
      expect(a.rows[0]?.value).toBe('markup');
      expect(b.rows[0]?.value).toBe('both');
    });

    // -----------------------------------------------------------------------
    // GET re-confirms the read seam still surfaces the set value (the S1
    // foundation proof carried forward against a real first-key row).
    // -----------------------------------------------------------------------
    it('GET /v1/tenant/settings surfaces compensation.display_default with the set value', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/tenant/settings`, {
        headers: { Authorization: `Bearer ${tenantAdminAJwt}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // S4 added audit.financials_enabled (default false) to the closed-
      // set registry; the materialized view now carries both keys.
      expect(body).toEqual({
        'compensation.display_default': 'markup',
        'audit.financials_enabled': false,
      });
    });
  },
);
