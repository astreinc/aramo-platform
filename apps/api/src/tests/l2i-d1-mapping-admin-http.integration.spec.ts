import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';

import { AppModule } from '../app.module.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

// L2-I (D1) — the mapping-admin HTTP surface authz + validation, end-to-end through a booted
// AppModule. The controller is THIN: the guard chain enforces the NARROW
// integration:pipeline-mapping:write for author (a caller holding only integration:read is
// DENIED), a cross-tenant / unknown connection conceals as 404, and the SERVICE's canonical-
// target rejection (COMPLETE / DOWNSTREAM_OUTCOME / opaque → 422, zero-write) flows through.
const ROOT = resolve(__dirname, '../../../..');
const AUDIENCE = 'aramo-l2i-mapping-admin-spec';
const ALG = 'RS256';
const ENTITLEMENT_INIT = resolve(ROOT, 'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql');
function integrationMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/integration/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
const TENANT_A = '01900000-0000-7000-8000-0000000000a1';
const CONN_A = '01900000-0000-7000-8000-0000000000c1';
const ADMIN = '00000000-0000-7000-8000-000000000aa1';
const MAPPING_WRITE = ['integration:read', 'integration:pipeline-mapping:write'];
const READ_ONLY = ['integration:read'];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'L2-I D1 mapping-admin HTTP authz (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let writeJwt = '';
    let readOnlyJwt = '';

    async function signJwt(key: unknown, scopes: string[], tenant = TENANT_A): Promise<string> {
      return new SignJWT({ sub: ADMIN, consumer_type: 'recruiter', actor_kind: 'user', tenant_id: tenant, scopes })
        .setProtectedHeader({ alg: ALG }).setIssuedAt().setIssuer('Aramo Core Auth').setAudience(AUDIENCE).setExpirationTime('1h')
        .sign(key as never);
    }
    const auth = (jwt: string): RequestInit => ({ headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' } });
    const url = (p: string): string => `http://127.0.0.1:${port}${p}`;
    const MAPPINGS = (conn: string): string => `/v1/integrations/${conn}/pipeline-provider-mappings`;
    const rowCount = async (): Promise<number> =>
      Number((await db.query(`SELECT count(*)::int c FROM integration."PipelineProviderDispositionMapping" WHERE connection_id=$1`, [CONN_A])).rows[0].c);

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const dburl = container.getConnectionUri();
      db = new Client({ connectionString: dburl });
      await db.connect();
      await db.query(readFileSync(ENTITLEMENT_INIT, 'utf8'));
      for (const p of integrationMigrations()) await db.query(readFileSync(p, 'utf8'));
      await ensureWriteFreezeTenant((s) => db.query(s), TENANT_A);
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid,'ats') ON CONFLICT DO NOTHING`, [TENANT_A]);
      await db.query(`INSERT INTO integration."IntegrationConnection" (id, tenant_id, provider_key, status, updated_at) VALUES ($1,$2,'acme_ats','active', now())`, [CONN_A, TENANT_A]);

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      savedEnv = { DATABASE_URL: process.env['DATABASE_URL'], AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'], AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'], ARAMO_ENV: process.env['ARAMO_ENV'] };
      process.env['DATABASE_URL'] = dburl; process.env['AUTH_AUDIENCE'] = AUDIENCE; process.env['AUTH_PUBLIC_KEY'] = publicPem; process.env['ARAMO_ENV'] = 'itest';
      writeJwt = await signJwt(kp.privateKey, MAPPING_WRITE);
      readOnlyJwt = await signJwt(kp.privateKey, READ_ONLY);

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
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

    it('authorized admin authors a canonical mapping (201) recorded under the active v1 set', async () => {
      const res = await fetch(url(MAPPINGS(CONN_A)), { method: 'POST', ...auth(writeJwt), body: JSON.stringify({ provider_token: 'hired', mapped_target: 'QUALIFY' }) });
      expect(res.status).toBe(201);
      const set = await db.query(`SELECT version, status FROM integration."PipelineProviderDispositionMappingSet" WHERE connection_id=$1`, [CONN_A]);
      expect(set.rows[0]).toMatchObject({ version: 1, status: 'active' });
      const row = await db.query(`SELECT mapped_target, target_kind, mapping_version FROM integration."PipelineProviderDispositionMapping" WHERE connection_id=$1 AND provider_token='hired'`, [CONN_A]);
      expect(row.rows[0]).toMatchObject({ mapped_target: 'QUALIFY', target_kind: 'action', mapping_version: 1 });
    });

    it('a caller holding only integration:read is DENIED author (403); the narrow scope is required', async () => {
      const before = await rowCount();
      const res = await fetch(url(MAPPINGS(CONN_A)), { method: 'POST', ...auth(readOnlyJwt), body: JSON.stringify({ provider_token: 'x', mapped_target: 'CONTACT' }) });
      expect(res.status).toBe(403);
      expect(await rowCount()).toBe(before); // 403 wrote nothing
    });

    it('GET lists the active mappings (integration:read)', async () => {
      const res = await fetch(url(MAPPINGS(CONN_A)), auth(readOnlyJwt));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<{ provider_token: string; mapped_target: string | null }> };
      expect(body.items.some((m) => m.provider_token === 'hired' && m.mapped_target === 'QUALIFY')).toBe(true);
    });

    it('COMPLETE target is rejected 422 (service validation flows through the thin controller); zero write', async () => {
      const before = await rowCount();
      const res = await fetch(url(MAPPINGS(CONN_A)), { method: 'POST', ...auth(writeJwt), body: JSON.stringify({ provider_token: 'placed', mapped_target: 'COMPLETE' }) });
      expect(res.status).toBe(422);
      expect((await res.json() as { error: { code: string } }).error.code).toBe('PIPELINE_PROVIDER_MAPPING_TARGET_INVALID');
      expect(await rowCount()).toBe(before);
    });

    it('a DOWNSTREAM_OUTCOME reason (placement_started) is rejected 422', async () => {
      const res = await fetch(url(MAPPINGS(CONN_A)), { method: 'POST', ...auth(writeJwt), body: JSON.stringify({ provider_token: 'started', mapped_target: 'placement_started' }) });
      expect(res.status).toBe(422);
    });

    it('a cross-tenant / unknown connection conceals as 404 (never 403)', async () => {
      const res = await fetch(url(MAPPINGS('01900000-0000-7000-8000-0000000000ff')), { method: 'POST', ...auth(writeJwt), body: JSON.stringify({ provider_token: 'y', mapped_target: 'CONTACT' }) });
      expect(res.status).toBe(404);
    });

    it('a missing provider_token is a 400 shape error', async () => {
      const res = await fetch(url(MAPPINGS(CONN_A)), { method: 'POST', ...auth(writeJwt), body: JSON.stringify({ mapped_target: 'CONTACT' }) });
      expect(res.status).toBe(400);
    });
  },
);
