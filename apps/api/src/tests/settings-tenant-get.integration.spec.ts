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

// Settings S1 — the endpoint-level foundation proof (Gate-5 §4 gate 1 (d)).
//
// Covers the directive §4 gate-1 foundation proofs the lib-level spec
// cannot reach because they live at the application boundary:
//   (d) `GET /v1/tenant/settings` is gated by `tenant:admin:settings`
//        — 403 without; 200 with; 401 without a token.
//
// Substrate proofs not duplicated here:
//   (a) the model migrates                — libs/settings integration spec
//   (b) get returns the code-default       — libs/settings integration spec
//   (c) get returns the row-value          — libs/settings integration spec
//   (e) per-tenant isolation               — libs/settings integration spec
//
// Migration set kept MINIMAL: only the schemas that the endpoint's guard
// chain + handler actually query.
//   - EntitlementGuard reads `entitlement.TenantEntitlement` (@RequireCapability)
//   - TenantSettingService reads `settings.TenantSetting` (the handler)
// Identity / company / etc. schemas are NOT migrated — AppModule's other
// PrismaServices are lazy (the post-PR-17 uniform pattern), so module
// construction doesn't touch them. Only the endpoint's hot path matters.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');

const ENTITLEMENT_INIT = resolve(
  ROOT,
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
);
const SETTINGS_INIT = resolve(
  ROOT,
  'libs/settings/prisma/migrations/20260605000000_init_settings_model/migration.sql',
);

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-settings-s1-spec';
const ALG = 'RS256';

const TENANT_ID = '11111111-0000-7000-8000-aaaaaaaaaaaa';
const TENANT_ADMIN_SUB = '00000000-0000-7000-8000-aaaaaaaaaaa1';
const RECRUITER_SUB = '00000000-0000-7000-8000-aaaaaaaaaaa2';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Settings S1 — GET /v1/tenant/settings endpoint proof',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    const savedEnv: Partial<Record<string, string | undefined>> = {};
    let setupClient: Client;
    let tenantAdminJwt: string;
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

      // Migration apply — the two schemas the endpoint touches.
      for (const p of [ENTITLEMENT_INIT, SETTINGS_INIT]) {
        await setupClient.query(readFileSync(p, 'utf8'));
      }

      // EntitlementGuard's read: the test tenant must hold the `core`
      // capability for the @RequireCapability('core') class-level decorator
      // on TenantSettingsController to pass. `core` is the baseline
      // capability — every tenant gets it; settings is a tenant-foundation,
      // not an ATS-feature.
      await setupClient.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
         VALUES ($1::uuid, 'core')
         ON CONFLICT (tenant_id, capability) DO NOTHING`,
        [TENANT_ID],
      );

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      const privateKey: SignKey = kp.privateKey as SignKey;

      savedEnv['DATABASE_URL'] = process.env['DATABASE_URL'];
      savedEnv['AUTH_AUDIENCE'] = process.env['AUTH_AUDIENCE'];
      savedEnv['AUTH_PUBLIC_KEY'] = process.env['AUTH_PUBLIC_KEY'];
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;

      // Two principals: one with `tenant:admin:settings` (passes the
      // scope-gate); one without (fails it). Same tenant for both — the
      // proof is about the SCOPE axis, not the tenant axis.
      tenantAdminJwt = await signJwt(privateKey, {
        sub: TENANT_ADMIN_SUB,
        tenant_id: TENANT_ID,
        scopes: ['tenant:admin:settings'],
      });
      recruiterJwt = await signJwt(privateKey, {
        sub: RECRUITER_SUB,
        tenant_id: TENANT_ID,
        // Intentionally lacks `tenant:admin:settings`.
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
    // Foundation proof (d) — the scope-gate behavior.
    // -----------------------------------------------------------------------

    it('200 — tenant_admin (holding tenant:admin:settings) gets `{}` (empty registry)', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/tenant/settings`, {
        headers: { Authorization: `Bearer ${tenantAdminJwt}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // S1 invariant: the materialized view is `{}` while the
      // `KNOWN_SETTINGS` registry is empty. S2's first key flips that
      // entry on.
      expect(body).toEqual({});
    });

    it('403 — recruiter (lacking tenant:admin:settings) is rejected by the scope-gate', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/tenant/settings`, {
        headers: { Authorization: `Bearer ${recruiterJwt}` },
      });
      // RolesGuard's scope-axis refusal: the principal authenticates +
      // is entitled (`core`) but does NOT hold `tenant:admin:settings`.
      // The canonical refusal code is INSUFFICIENT_PERMISSIONS at 403.
      expect(res.status).toBe(403);
    });

    it('401 — missing bearer token is rejected by JwtAuthGuard', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/tenant/settings`);
      // JwtAuthGuard refuses at the AuthN axis (no token to verify).
      expect(res.status).toBe(401);
    });
  },
);
