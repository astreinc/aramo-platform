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

// COMM-B7 — disposition write + Talent communication timeline, HTTP boundary +
// real Postgres 17. Proves: disposition is append-only + state-agnostic +
// tenant-safe-404; notes requires BOTH write scopes; do_not_contact records with
// NO consent mutation; timeline is keyset-paginated (created_at DESC, id DESC),
// carries disposition history, 200-empty (never 404) for an unknown talent, and
// tenant-isolated. Skipped unless ARAMO_RUN_INTEGRATION=1.

type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../..');
const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-comm-b7-spec';
const ALG = 'RS256';
const M = (p: string): string => resolve(ROOT, p);
const MIGRATIONS = [
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
  'libs/communications/prisma/migrations/20260825120000_init_communications/migration.sql',
  'libs/integration/prisma/migrations/20260814170000_init_integration_connection/migration.sql',
].map(M);

const TENANT_A = '01900000-0000-7000-8000-00000000b7a1';
const TENANT_B = '01900000-0000-7000-8000-00000000b7b2';
const CONNECTION = '01900000-0000-7000-8000-00000000b7c1';
const RECRUITER = '00000000-0000-7000-8000-00000000b7a1';
const TALENT = '01900000-0000-7000-8000-00000000b711';
const TALENT_EMPTY = '01900000-0000-7000-8000-00000000b7ee';
// Three tenant-A interactions on TALENT, created t1<t2<t3.
const I1 = '01900000-0000-7000-8000-00000000d701';
const I2 = '01900000-0000-7000-8000-00000000d702';
const I3 = '01900000-0000-7000-8000-00000000d703';
// A tenant-B interaction on the SAME talent id (isolation).
const I_B = '01900000-0000-7000-8000-00000000d7b0';

const DISP = ['communication:disposition:write'];
const DISP_NOTES = ['communication:disposition:write', 'communication:notes:write'];
const READ = ['communication:read'];
const NO_COMM = ['requisition:import:read'];

class FakeSecretsWriter implements SecretsManagerWriterPort {
  async putSecretValue(): Promise<void> {
    /* no-op */
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'COMM-B7 disposition + timeline — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let key: SignKey;

    function auth(jwt: string): RequestInit {
      return { headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' } };
    }
    async function jwtFor(tenant: string, scopes: string[]): Promise<string> {
      return new SignJWT({ sub: RECRUITER, consumer_type: 'recruiter', actor_kind: 'user', tenant_id: tenant, authz_version: __authzTestResolver.grant(tenant, RECRUITER, scopes)})
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(key);
    }
    async function seedInteraction(id: string, tenant: string, createdAt: string): Promise<void> {
      await db.query(
        `INSERT INTO communications."CommunicationInteraction"
           (id, tenant_id, channel, direction, status, integration_connection_id, from_address, to_address, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'voice', 'outbound', 'created', $3::uuid, '+15715550100', '+17035550111', $4::timestamptz, $4::timestamptz)`,
        [id, tenant, CONNECTION, createdAt],
      );
      await db.query(
        `INSERT INTO communications."CommunicationAssociation"
           (id, tenant_id, interaction_id, subject_type, subject_id, relation_type)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'talent_record', $3::uuid, 'subject')`,
        [tenant, id, TALENT],
      );
    }
    async function dispositionCount(interactionId: string): Promise<number> {
      const r = await db.query(
        `SELECT count(*)::int AS n FROM communications."CommunicationDisposition" WHERE interaction_id = $1::uuid`,
        [interactionId],
      );
      return (r.rows[0] as { n: number }).n;
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
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid, 'ats') ON CONFLICT DO NOTHING`,
          [t],
        );
      }
      await db.query(
        `INSERT INTO integration."IntegrationConnection"
           (id, tenant_id, provider_key, status, secret_ref, provider_account_id, version, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'zoom_phone', 'configured', 'seed', 'acct', 0, now(), now())`,
        [CONNECTION, TENANT_A],
      );
      await seedInteraction(I1, TENANT_A, '2026-08-26T10:00:00.000Z');
      await seedInteraction(I2, TENANT_A, '2026-08-26T11:00:00.000Z');
      await seedInteraction(I3, TENANT_A, '2026-08-26T12:00:00.000Z');
      await seedInteraction(I_B, TENANT_B, '2026-08-26T13:00:00.000Z');

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      key = kp.privateKey as SignKey;
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

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EFFECTIVE_AUTHORIZATION_RESOLVER)
        .useValue(__authzTestResolver)
        .overrideProvider(SECRETS_MANAGER_WRITER)
        .useValue(new FakeSecretsWriter())
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
    const dispPath = (id: string) => `/v1/communications/interactions/${id}/disposition`;
    const timelinePath = (t: string) => `/v1/talents/${t}/communications`;

    // ---- disposition ----

    it('records a disposition (201) with disposition:write; state-agnostic on `created`', async () => {
      const jwt = await jwtFor(TENANT_A, DISP);
      const res = await fetch(url(dispPath(I1)), { method: 'POST', ...auth(jwt), body: JSON.stringify({ disposition: 'no_answer' }) });
      expect(res.status).toBe(201);
      expect(await dispositionCount(I1)).toBe(1);
    });

    it('do_not_contact records with NO consent mutation (pure recorded outcome)', async () => {
      const jwt = await jwtFor(TENANT_A, DISP);
      const res = await fetch(url(dispPath(I1)), { method: 'POST', ...auth(jwt), body: JSON.stringify({ disposition: 'do_not_contact' }) });
      expect(res.status).toBe(201);
      // Append-only: I1 now has two disposition rows (no upsert/replace).
      expect(await dispositionCount(I1)).toBe(2);
    });

    it('notes without communication:notes:write → 403 INSUFFICIENT_PERMISSIONS, nothing written', async () => {
      const jwt = await jwtFor(TENANT_A, DISP);
      const before = await dispositionCount(I2);
      const res = await fetch(url(dispPath(I2)), { method: 'POST', ...auth(jwt), body: JSON.stringify({ disposition: 'connected', notes: 'spoke with the talent' }) });
      expect(res.status).toBe(403);
      const err = (await res.json()) as { error?: { code?: string } };
      expect(err.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(await dispositionCount(I2)).toBe(before);
    });

    it('notes with BOTH write scopes → 201 and notes stored', async () => {
      const jwt = await jwtFor(TENANT_A, DISP_NOTES);
      const res = await fetch(url(dispPath(I2)), { method: 'POST', ...auth(jwt), body: JSON.stringify({ disposition: 'connected', notes: 'spoke with the talent' }) });
      expect(res.status).toBe(201);
      const r = await db.query(`SELECT notes FROM communications."CommunicationDisposition" WHERE interaction_id = $1::uuid`, [I2]);
      expect((r.rows[0] as { notes: string }).notes).toBe('spoke with the talent');
    });

    it('disposition without disposition:write → 403', async () => {
      const jwt = await jwtFor(TENANT_A, NO_COMM);
      const res = await fetch(url(dispPath(I1)), { method: 'POST', ...auth(jwt), body: JSON.stringify({ disposition: 'no_answer' }) });
      expect(res.status).toBe(403);
    });

    it('disposition on unknown/cross-tenant interaction → 404 tenant-safe', async () => {
      const jwt = await jwtFor(TENANT_A, DISP);
      const res = await fetch(url(dispPath(I_B)), { method: 'POST', ...auth(jwt), body: JSON.stringify({ disposition: 'no_answer' }) });
      expect(res.status).toBe(404);
      const err = (await res.json()) as { error?: { code?: string } };
      expect(err.error?.code).toBe('COMMUNICATION_INTERACTION_NOT_FOUND');
    });

    it('rejects an invalid disposition outcome → 400 VALIDATION_ERROR', async () => {
      const jwt = await jwtFor(TENANT_A, DISP);
      const res = await fetch(url(dispPath(I1)), { method: 'POST', ...auth(jwt), body: JSON.stringify({ disposition: 'made_up' }) });
      expect(res.status).toBe(400);
    });

    // ---- timeline ----

    it('timeline: 200 ordered created_at DESC, id DESC, with disposition history', async () => {
      const jwt = await jwtFor(TENANT_A, READ);
      const res = await fetch(url(timelinePath(TALENT)), auth(jwt));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<{ id: string; dispositions: Array<{ disposition: string }> }>; next_cursor: string | null };
      expect(body.items.map((i) => i.id)).toEqual([I3, I2, I1]); // newest first
      expect(body.next_cursor).toBeNull();
      const i1 = body.items.find((i) => i.id === I1);
      // I1 carries its two dispositions (no_answer + do_not_contact), newest first.
      expect(i1?.dispositions.map((d) => d.disposition)).toEqual(['do_not_contact', 'no_answer']);
    });

    it('timeline: keyset pagination (limit=1) yields a cursor that advances', async () => {
      const jwt = await jwtFor(TENANT_A, READ);
      const first = await fetch(url(`${timelinePath(TALENT)}?limit=1`), auth(jwt));
      const p1 = (await first.json()) as { items: Array<{ id: string }>; next_cursor: string | null };
      expect(p1.items.map((i) => i.id)).toEqual([I3]);
      expect(p1.next_cursor).not.toBeNull();
      const second = await fetch(url(`${timelinePath(TALENT)}?limit=1&cursor=${encodeURIComponent(p1.next_cursor as string)}`), auth(jwt));
      const p2 = (await second.json()) as { items: Array<{ id: string }> };
      expect(p2.items.map((i) => i.id)).toEqual([I2]);
    });

    it('timeline: unknown talent (no communications) → 200 empty, NOT 404', async () => {
      const jwt = await jwtFor(TENANT_A, READ);
      const res = await fetch(url(timelinePath(TALENT_EMPTY)), auth(jwt));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[]; next_cursor: string | null };
      expect(body.items).toEqual([]);
      expect(body.next_cursor).toBeNull();
    });

    it('timeline: tenant-isolated (tenant B does not see tenant A talent interactions)', async () => {
      const jwt = await jwtFor(TENANT_B, READ);
      const res = await fetch(url(timelinePath(TALENT)), auth(jwt));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<{ id: string }> };
      // Only the tenant-B interaction on this talent id is visible.
      expect(body.items.map((i) => i.id)).toEqual([I_B]);
    });

    it('timeline: invalid cursor → 400, limit>200 → 400', async () => {
      const jwt = await jwtFor(TENANT_A, READ);
      const bad = await fetch(url(`${timelinePath(TALENT)}?cursor=not-a-cursor`), auth(jwt));
      expect(bad.status).toBe(400);
      const over = await fetch(url(`${timelinePath(TALENT)}?limit=999`), auth(jwt));
      expect(over.status).toBe(400);
    });

    it('timeline: DENIED without communication:read → 403', async () => {
      const jwt = await jwtFor(TENANT_A, NO_COMM);
      const res = await fetch(url(timelinePath(TALENT)), auth(jwt));
      expect(res.status).toBe(403);
    });
  },
);
