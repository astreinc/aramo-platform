import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey, type KeyObject } from 'jose';
import { SECRETS_MANAGER_WRITER, type SecretsManagerWriterPort } from '@aramo/integration';
import { EFFECTIVE_AUTHORIZATION_RESOLVER } from '@aramo/auth';

import { AppModule } from '../app.module.js';

import { ConfigurableTestResolver } from './support/test-auth-harness.js';
import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

// HF-AUTH-1 — compact tokens carry no scopes; guard resolves via this resolver.
const __authzTestResolver = new ConfigurableTestResolver();

// T8-CONNECTOR-A — HTTP-boundary authz + tenant-safe-404 integration proof
// (directive §46, Architect FIX_NOW #2). Exercises the REAL guard chain
// (JwtAuthGuard + EntitlementGuard + RolesGuard) against a booted AppModule +
// real Postgres 17. Skipped unless ARAMO_RUN_INTEGRATION=1.

type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../..');
const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-connector-authz-spec';
const ALG = 'RS256';

const ENTITLEMENT_INIT = resolve(ROOT, 'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql');
const INTEGRATION_INIT = resolve(ROOT, 'libs/integration/prisma/migrations/20260814170000_init_integration_connection/migration.sql');
const MIGRATIONS = [ENTITLEMENT_INIT, INTEGRATION_INIT];

const TENANT_A = '01900000-0000-7000-8000-0000000000a1';
const TENANT_B = '01900000-0000-7000-8000-0000000000b2';
const ADMIN = '00000000-0000-7000-8000-000000000aa1';

// The RolesGuard reads scopes from the JWT; pass them directly.
const WRITE_SCOPES = ['integration:read', 'integration:write'];
const READ_ONLY_SCOPES = ['integration:read'];
const NO_INTEGRATION_SCOPES = ['requisition:import:read'];

class FakeSecretsWriter implements SecretsManagerWriterPort {
  readonly puts: Array<{ secretId: string; value: string }> = [];
  async putSecretValue(secretId: string, value: string): Promise<void> {
    this.puts.push({ secretId, value });
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T8-CONNECTOR-A connector-management HTTP authz — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    const fakeWriter = new FakeSecretsWriter();

    let writeJwt: string;
    let readOnlyJwt: string;
    let noReadJwt: string;
    let tenantBWriteJwt: string;

    function auth(jwt: string): RequestInit {
      return { headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' } };
    }

    async function signJwt(key: SignKey, args: { tenant_id: string; scopes: string[] }): Promise<string> {
      return new SignJWT({
        sub: ADMIN,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: args.tenant_id,
        authz_version: __authzTestResolver.grant(args.tenant_id, ADMIN, args.scopes),
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(key);
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await ensureWriteFreezeTenant((s) => db.query(s), TENANT_A);
      await ensureWriteFreezeTenant((s) => db.query(s), TENANT_B);
      for (const t of [TENANT_A, TENANT_B]) {
        await db.query(
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid, 'ats') ON CONFLICT (tenant_id, capability) DO NOTHING`,
          [t],
        );
      }

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      const key: SignKey = kp.privateKey as SignKey;

      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
        ARAMO_ENV: process.env['ARAMO_ENV'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;
      process.env['ARAMO_ENV'] = 'itest';

      writeJwt = await signJwt(key, { tenant_id: TENANT_A, scopes: WRITE_SCOPES });
      readOnlyJwt = await signJwt(key, { tenant_id: TENANT_A, scopes: READ_ONLY_SCOPES });
      noReadJwt = await signJwt(key, { tenant_id: TENANT_A, scopes: NO_INTEGRATION_SCOPES });
      tenantBWriteJwt = await signJwt(key, { tenant_id: TENANT_B, scopes: WRITE_SCOPES });

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EFFECTIVE_AUTHORIZATION_RESOLVER)
        .useValue(__authzTestResolver)
        .overrideProvider(SECRETS_MANAGER_WRITER)
        .useValue(fakeWriter)
        .compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;
    }, 240_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    const url = (p: string) => `http://127.0.0.1:${port}${p}`;

    it('GET is DENIED without integration:read (least-visibility 403)', async () => {
      const res = await fetch(url('/v1/integrations'), auth(noReadJwt));
      expect(res.status).toBe(403);
    });

    it('GET is ALLOWED with integration:read (200)', async () => {
      const res = await fetch(url('/v1/integrations'), auth(readOnlyJwt));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(Array.isArray(body.items)).toBe(true);
    });

    it('a read-only caller is DENIED mutations (POST 403)', async () => {
      const res = await fetch(url('/v1/integrations'), {
        method: 'POST',
        ...auth(readOnlyJwt),
        body: JSON.stringify({ provider_key: 'acme_vms' }),
      });
      expect(res.status).toBe(403);
    });

    it('integration:write can create, and GET never exposes secret material', async () => {
      const created = await fetch(url('/v1/integrations'), {
        method: 'POST',
        ...auth(writeJwt),
        body: JSON.stringify({ provider_key: 'acme_vms' }),
      });
      expect(created.status).toBe(201);
      const conn = (await created.json()) as { id: string; has_secret: boolean; status: string };
      expect(conn.status).toBe('disconnected');
      expect(conn.has_secret).toBe(false);

      const got = await fetch(url(`/v1/integrations/${conn.id}`), auth(readOnlyJwt));
      expect(got.status).toBe(200);
      const raw = await got.text();
      expect(raw).not.toMatch(/secret_ref|aramo\/[a-z]+\/connector|connector:v1/);
    });

    it('enable without a credential → 409 CONNECTOR_CONFIGURATION_INVALID', async () => {
      const created = await fetch(url('/v1/integrations'), {
        method: 'POST',
        ...auth(writeJwt),
        body: JSON.stringify({ provider_key: 'acme_vms' }),
      });
      const conn = (await created.json()) as { id: string };
      const res = await fetch(url(`/v1/integrations/${conn.id}/enable`), { method: 'POST', ...auth(writeJwt) });
      expect(res.status).toBe(409);
      const err = (await res.json()) as { error?: { code?: string } };
      expect(err.error?.code).toBe('CONNECTOR_CONFIGURATION_INVALID');
    });

    it('write-only credential set → 200, no credential echoed; then enable → active', async () => {
      const created = await fetch(url('/v1/integrations'), {
        method: 'POST',
        ...auth(writeJwt),
        body: JSON.stringify({ provider_key: 'acme_vms' }),
      });
      const conn = (await created.json()) as { id: string };
      const set = await fetch(url(`/v1/integrations/${conn.id}/credential`), {
        method: 'POST',
        ...auth(writeJwt),
        body: JSON.stringify({ credential: 'super-secret-value' }),
      });
      expect(set.status).toBe(200);
      const raw = await set.text();
      expect(raw).not.toContain('super-secret-value'); // no echo
      expect(fakeWriter.puts.some((p) => p.value === 'super-secret-value')).toBe(true); // went to SM
      const view = JSON.parse(raw) as { has_secret: boolean };
      expect(view.has_secret).toBe(true);

      const en = await fetch(url(`/v1/integrations/${conn.id}/enable`), { method: 'POST', ...auth(writeJwt) });
      expect(en.status).toBe(200);
      expect(((await en.json()) as { status: string }).status).toBe('active');
    });

    it('tenant B cannot read tenant A\'s connection → tenant-safe 404', async () => {
      const created = await fetch(url('/v1/integrations'), {
        method: 'POST',
        ...auth(writeJwt),
        body: JSON.stringify({ provider_key: 'acme_vms' }),
      });
      const conn = (await created.json()) as { id: string };
      const res = await fetch(url(`/v1/integrations/${conn.id}`), auth(tenantBWriteJwt));
      expect(res.status).toBe(404);
    });
  },
);
