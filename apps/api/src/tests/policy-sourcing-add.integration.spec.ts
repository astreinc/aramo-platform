import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey, type KeyObject } from 'jose';

import { AppModule } from '../app.module.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';
import { publishLifecyclePackage } from './publish-lifecycle-package.js';

// ADR-0024 PR-3b/PR-4a — the SECOND command boundary for REQUISITION_TALENT ·
// ADD: POST /v1/sourcing/pipeline. Real Postgres 17; skipped unless
// ARAMO_RUN_INTEGRATION=1.
//
// PR-4a: the package is RETRIEVED from policy-store (no DI-token override). The
// permissive tenant publishes it; the DENY is the shipped-config fail-closed
// (no published package). Sourcing-unique behaviours only — no SRC-1 seed, no
// atomicity re-proof (create()'s in-tx provenance + rollback are proven in
// PR-3). Threading proof + negative invariant live in the unit specs.

type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../..');
const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-policy-sourcing-spec';
const ALG = 'RS256';
const TENANT = '01900000-0000-7000-8000-0000000000d3'; // has a published package
const TENANT_NP = '01900000-0000-7000-8000-0000000000d4'; // NO package → fail closed
const ACTOR = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaad3';

function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
const MIGRATIONS = [
  ...migrationsFor('entitlement'),
  ...migrationsFor('requisition'),
  ...migrationsFor('pipeline'),
  ...migrationsFor('policy-store'),
  ...migrationsFor('talent-trust'),
  ...migrationsFor('talent-record'),
];

let uuidCounter = 0;
function uuid(): string {
  uuidCounter += 1;
  return `00000000-0000-7000-8000-${uuidCounter.toString(16).padStart(12, '0')}`;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PR-3b/4a sourcing policy gate — POST /v1/sourcing/pipeline (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let signingKey: SignKey;
    let app: INestApplication;
    let savedEnv: Partial<Record<string, string | undefined>> = {};

    async function signJwt(tenant: string): Promise<string> {
      return new SignJWT({
        sub: ACTOR,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: tenant,
        scopes: ['talent:source'],
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(signingKey);
    }

    async function seedRequisition(tenant: string, status: string): Promise<string> {
      const id = uuid();
      await db.query(
        `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, status)
         VALUES ($1,$2,$3,$4,$5::"requisition"."RequisitionStatus")`,
        [id, tenant, `req-${status}`, uuid(), status],
      );
      return id;
    }
    function baseUrl(): string {
      const a = app.getHttpServer().address();
      return `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`;
    }
    async function postAdd(jwt: string, requisitionId: string): Promise<Response> {
      return fetch(`${baseUrl()}/v1/sourcing/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref_type: 'SOURCED_TALENT', ref_id: uuid(), requisition_id: requisitionId }),
      });
    }
    async function pipelineCount(reqId: string): Promise<number> {
      return (await db.query(`SELECT count(*)::int n FROM pipeline."Pipeline" WHERE requisition_id=$1`, [reqId])).rows[0].n;
    }
    async function talentRecordCount(tenant: string): Promise<number> {
      return (await db.query(`SELECT count(*)::int n FROM talent_record."TalentRecord" WHERE tenant_id=$1`, [tenant])).rows[0].n;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const dbUrl = container.getConnectionUri();
      db = new Client({ connectionString: dbUrl });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      for (const t of [TENANT, TENANT_NP]) {
        await ensureWriteFreezeTenant((s) => db.query(s), t);
        await db.query(
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1,'core') ON CONFLICT DO NOTHING`,
          [t],
        );
      }
      // Only TENANT gets a published package; TENANT_NP stays package-less.
      await publishLifecyclePackage(dbUrl, TENANT);

      const kp = await generateKeyPair(ALG);
      signingKey = kp.privateKey as SignKey;
      const pem = await exportSPKI(kp.publicKey as never);
      savedEnv = { DATABASE_URL: process.env['DATABASE_URL'], AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'], AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'] };
      process.env['DATABASE_URL'] = dbUrl;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = pem;

      const mod: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = mod.createNestApplication();
      app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
      await app.init();
      await app.listen(0);
    }, 120_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }, 60_000);

    it('FAIL CLOSED — no published package → 403 POLICY_DENIED (reason_code only), no pipeline row, NO promotion, provenance recorded', async () => {
      const req = await seedRequisition(TENANT_NP, 'active');
      const before = await talentRecordCount(TENANT_NP);
      const res = await postAdd(await signJwt(TENANT_NP), req);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: { code?: string; details?: Record<string, unknown> } };
      expect(body.error?.code).toBe('POLICY_DENIED');
      expect(body.error?.details?.reason_code).toBe('NO_POLICY_PUBLISHED');
      expect(await pipelineCount(req)).toBe(0);
      expect(await talentRecordCount(TENANT_NP)).toBe(before); // ruling 4 — no promotion
      const rec = (await db.query(
        `SELECT decision FROM policy_store."PolicyDecisionRecord" WHERE tenant_id=$1 AND reason_code='NO_POLICY_PUBLISHED' ORDER BY occurred_at DESC LIMIT 1`,
        [TENANT_NP],
      )).rows;
      expect(rec).toHaveLength(1);
      expect(rec[0].decision).toBe('DENY');
    });

    it('ALLOW that DEFERS (unknown subject) → 200 deferral, no pipeline row, provenance decision=ALLOW with the STORED version/rule_id', async () => {
      const req = await seedRequisition(TENANT, 'active');
      const res = await postAdd(await signJwt(TENANT), req);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status?: string };
      expect(body.status).toBe('deferred_unknown_subject');
      expect(await pipelineCount(req)).toBe(0);
      // ALLOW recorded standalone (invariant: provenance may exist without a
      // mutation), carrying the engine's ALLOW + the STORED (retrieved) version.
      const rec = (await db.query(
        `SELECT decision, policy_version, rule_id FROM policy_store."PolicyDecisionRecord" WHERE tenant_id=$1 AND decision='ALLOW' ORDER BY occurred_at DESC LIMIT 1`,
        [TENANT],
      )).rows;
      expect(rec).toHaveLength(1);
      expect(rec[0].policy_version).toBe('2.0.0'); // PR-4c restrictive matrix
      expect(rec[0].rule_id).toBe('add-talent-active');
    });
  },
);
