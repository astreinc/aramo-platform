import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey, type KeyObject } from 'jose';
import type { PolicyPackage } from '@aramo/policy-engine';

import { AppModule } from '../app.module.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

// ADR-0024 PR-3b — the SECOND command boundary for REQUISITION_TALENT · ADD:
// POST /v1/sourcing/pipeline. Real Postgres 17; skipped unless
// ARAMO_RUN_INTEGRATION=1.
//
// SCOPE (per the (b) ruling): the sourcing-UNIQUE behaviours only — no SRC-1
// promotable-subject seed, no sourcing atomicity re-proof (create()'s in-tx
// provenance + rollback are a property of create(), proven in PR-3; it is the
// same method). Covers: DENY refusal, and an ALLOW that DEFERS still recording
// the ALLOW decision. The threading proof + negative invariant live in the
// unit specs (sourcing.service.spec / sourcing-policy-controller.spec).

type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../..');
const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-policy-sourcing-spec';
const ALG = 'RS256';
const TENANT = '01900000-0000-7000-8000-0000000000d3';
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

// TEST-ONLY restrictive package (via the REQUISITION_ADD_POLICY_PACKAGE token).
// The shipped package is permissive; production cannot produce DENY.
const DENY_PACKAGE: PolicyPackage = {
  name: 'test-restrictive',
  version: '9.9.9',
  registry: { resources: ['REQUISITION_TALENT'], actions: ['ADD'] },
  default_disposition: { decision: 'ALLOW', reason_code: 'DEFAULT_ALLOW' },
  rules: [
    {
      id: 'deny-closed',
      resource: 'REQUISITION_TALENT',
      action: 'ADD',
      when: [{ source: 'declared', key: 'status', op: 'eq', value: 'closed' }],
      decision: 'DENY',
      reason_code: 'LIFECYCLE_ADD_DENIED',
    },
  ],
};

let uuidCounter = 0;
function uuid(): string {
  uuidCounter += 1;
  return `00000000-0000-7000-8000-${uuidCounter.toString(16).padStart(12, '0')}`;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PR-3b sourcing policy gate — POST /v1/sourcing/pipeline (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let signingKey: SignKey;
    let savedEnv: Partial<Record<string, string | undefined>> = {};

    async function signJwt(): Promise<string> {
      return new SignJWT({
        sub: ACTOR,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: TENANT,
        scopes: ['talent:source'],
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(signingKey);
    }

    async function seedRequisition(status: string): Promise<string> {
      const id = uuid();
      await db.query(
        `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, status)
         VALUES ($1,$2,$3,$4,$5::"requisition"."RequisitionStatus")`,
        [id, TENANT, `req-${status}`, uuid(), status],
      );
      return id;
    }

    async function buildApp(overridePackage?: PolicyPackage): Promise<INestApplication> {
      let builder = Test.createTestingModule({ imports: [AppModule] });
      if (overridePackage !== undefined) {
        builder = builder.overrideProvider('REQUISITION_ADD_POLICY_PACKAGE').useValue(overridePackage);
      }
      const mod: TestingModule = await builder.compile();
      const app = mod.createNestApplication();
      app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
      await app.init();
      await app.listen(0);
      return app;
    }
    function url(app: INestApplication): string {
      const a = app.getHttpServer().address();
      return `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`;
    }
    async function postAdd(app: INestApplication, jwt: string, requisitionId: string): Promise<Response> {
      return fetch(`${url(app)}/v1/sourcing/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref_type: 'SOURCED_TALENT', ref_id: uuid(), requisition_id: requisitionId }),
      });
    }
    async function pipelineCount(reqId: string): Promise<number> {
      return (await db.query(`SELECT count(*)::int n FROM pipeline."Pipeline" WHERE requisition_id=$1`, [reqId])).rows[0].n;
    }
    async function talentRecordCount(): Promise<number> {
      return (await db.query(`SELECT count(*)::int n FROM talent_record."TalentRecord" WHERE tenant_id=$1`, [TENANT])).rows[0].n;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const dbUrl = container.getConnectionUri();
      db = new Client({ connectionString: dbUrl });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await ensureWriteFreezeTenant((s) => db.query(s), TENANT);
      await db.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1,'core') ON CONFLICT DO NOTHING`,
        [TENANT],
      );
      const kp = await generateKeyPair(ALG);
      signingKey = kp.privateKey as SignKey;
      const pem = await exportSPKI(kp.publicKey as never);
      savedEnv = { DATABASE_URL: process.env['DATABASE_URL'], AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'], AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'] };
      process.env['DATABASE_URL'] = dbUrl;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = pem;
    }, 120_000);

    afterAll(async () => {
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }, 60_000);

    describe('DENY (test-only restrictive package)', () => {
      let app: INestApplication;
      beforeAll(async () => { app = await buildApp(DENY_PACKAGE); });
      afterAll(async () => { await app?.close(); });

      it('DENY → 403 POLICY_DENIED (reason_code only), no pipeline row, NO promotion, provenance recorded', async () => {
        const req = await seedRequisition('closed');
        const before = await talentRecordCount();
        const res = await postAdd(app, await signJwt(), req);
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error?: { code?: string; details?: Record<string, unknown> } };
        expect(body.error?.code).toBe('POLICY_DENIED');
        expect(body.error?.details?.reason_code).toBe('LIFECYCLE_ADD_DENIED');
        expect(JSON.stringify(body)).not.toContain('deny-closed'); // no rule_id
        expect(JSON.stringify(body)).not.toContain('9.9.9'); // no policy_version
        expect(await pipelineCount(req)).toBe(0);
        expect(await talentRecordCount()).toBe(before); // ruling 4 — no promotion
        const rec = (await db.query(
          `SELECT decision FROM policy_store."PolicyDecisionRecord" WHERE reason_code='LIFECYCLE_ADD_DENIED' ORDER BY occurred_at DESC LIMIT 1`,
        )).rows;
        expect(rec).toHaveLength(1);
        expect(rec[0].decision).toBe('DENY');
      });
    });

    describe('ALLOW + deferral (shipped permissive package)', () => {
      let app: INestApplication;
      beforeAll(async () => { app = await buildApp(); });
      afterAll(async () => { await app?.close(); });

      it('ALLOW that DEFERS (unknown subject) → 200 deferral, no pipeline row, provenance decision=ALLOW with real version/rule_id', async () => {
        const req = await seedRequisition('active');
        const res = await postAdd(app, await signJwt(), req);
        // 200 with a deferral status (unknown subject → deferred), no throw.
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status?: string; pipeline_id?: string | null };
        expect(body.status).toBe('deferred_unknown_subject');
        expect(await pipelineCount(req)).toBe(0);
        // The ALLOW decision was recorded standalone (invariant: provenance may
        // exist without a mutation), carrying the ENGINE's decision, not the deferral.
        const rec = (await db.query(
          `SELECT decision, policy_version, rule_id FROM policy_store."PolicyDecisionRecord" WHERE actor_id=$1 AND decision='ALLOW' ORDER BY occurred_at DESC LIMIT 1`,
          [ACTOR],
        )).rows;
        expect(rec).toHaveLength(1);
        expect(rec[0].policy_version).toBe('1.0.0');
        expect(rec[0].rule_id).toBe('add-talent-active');
      });
    });
  },
);
