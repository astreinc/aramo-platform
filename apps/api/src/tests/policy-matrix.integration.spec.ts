import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey, type KeyObject } from 'jose';
import { evaluate, type Decision, type PolicyContext } from '@aramo/policy-engine';
import { PolicyStore, PrismaService as PolicyStorePrismaService } from '@aramo/policy-store';

import { AppModule } from '../app.module.js';
import { REQUISITION_LIFECYCLE_PACKAGE } from '../policy/requisition-lifecycle.package.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

// ADR-0024 PR-4c — the RESTRICTIVE MATRIX v2.0.0, E2E against a REAL published
// package. Real Postgres 17; skipped unless ARAMO_RUN_INTEGRATION=1.
//   (1) every cell (24) evaluated against the PUBLISHED + RETRIEVED (checksum-
//       verified) package;
//   (2) the ADD column enforced over HTTP on BOTH command boundaries (one
//       rulebook, both callers);
//   (3) §D17b — a decision made before v2.0.0 still names the OLD version when
//       re-read from the database after publishing.

type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../..');
const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-policy-matrix-spec';
const ALG = 'RS256';
const TENANT = '01900000-0000-7000-8000-0000000000f5';
const SITE = '33333333-3333-7333-8333-3333333333f5';
const ACTOR = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaf5';
const SYSTEM_PUBLISHER = '00000000-0000-0000-0000-000000000000';
const OVERRIDE_CAP = 'requisition.override.submittal_closed';
const PKG_NAME = REQUISITION_LIFECYCLE_PACKAGE.name;

const ACTION: Readonly<Record<string, string>> = {
  REQUISITION_TALENT: 'ADD', REQUISITION_SUBMITTAL: 'CREATE', REQUISITION_NOTE: 'ADD', REQUISITION_DOCUMENT: 'ADD',
};
const EXPECTED: Readonly<Record<string, Readonly<Record<string, Decision>>>> = {
  active: { REQUISITION_TALENT: 'ALLOW', REQUISITION_SUBMITTAL: 'ALLOW', REQUISITION_NOTE: 'ALLOW', REQUISITION_DOCUMENT: 'ALLOW' },
  on_hold: { REQUISITION_TALENT: 'ALLOW', REQUISITION_SUBMITTAL: 'DENY', REQUISITION_NOTE: 'ALLOW', REQUISITION_DOCUMENT: 'ALLOW' },
  full: { REQUISITION_TALENT: 'REQUIRES_OVERRIDE', REQUISITION_SUBMITTAL: 'REQUIRES_OVERRIDE', REQUISITION_NOTE: 'ALLOW', REQUISITION_DOCUMENT: 'REQUIRES_OVERRIDE' },
  closed: { REQUISITION_TALENT: 'DENY', REQUISITION_SUBMITTAL: 'DENY', REQUISITION_NOTE: 'ALLOW', REQUISITION_DOCUMENT: 'DENY' },
  canceled: { REQUISITION_TALENT: 'DENY', REQUISITION_SUBMITTAL: 'DENY', REQUISITION_NOTE: 'ALLOW', REQUISITION_DOCUMENT: 'DENY' },
  lead: { REQUISITION_TALENT: 'ALLOW', REQUISITION_SUBMITTAL: 'DENY', REQUISITION_NOTE: 'ALLOW', REQUISITION_DOCUMENT: 'ALLOW' },
};

function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
const MIGRATIONS = [
  ...migrationsFor('entitlement'), ...migrationsFor('requisition'), ...migrationsFor('pipeline'),
  ...migrationsFor('policy-store'), ...migrationsFor('talent-trust'), ...migrationsFor('talent-record'),
];

let uuidCounter = 0;
function uuid(): string {
  uuidCounter += 1;
  return `00000000-0000-7000-8000-${uuidCounter.toString(16).padStart(12, '0')}`;
}
function contextFor(status: string, resource: string): PolicyContext {
  return {
    tenant_id: TENANT, resource, action: ACTION[resource]!,
    resource_state: { declared: { status }, derived: {} },
    principal_capabilities: {}, request_metadata: { correlation_id: 'c', origin: 'ui' },
    environment: 'production', time: new Date('2026-07-31T00:00:00Z').toISOString(), attributes: {},
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PR-4c restrictive matrix v2.0.0 — real published package (Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let store: PolicyStore;
    let storePrisma: PolicyStorePrismaService;
    let signingKey: SignKey;
    let app: INestApplication;
    let savedEnv: Partial<Record<string, string | undefined>> = {};

    async function signJwt(scopes: string[]): Promise<string> {
      return new SignJWT({ sub: ACTOR, consumer_type: 'recruiter', actor_kind: 'user', tenant_id: TENANT, site_id: SITE, scopes })
        .setProtectedHeader({ alg: ALG }).setIssuedAt().setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime('1h').sign(signingKey);
    }
    async function seedRequisition(status: string): Promise<string> {
      const id = uuid();
      await db.query(`INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, status, requisition_number) VALUES ($1,$2,$3,$4,$5::"requisition"."RequisitionStatus", (SELECT COALESCE(MAX(rn.requisition_number),999)+1 FROM requisition."Requisition" rn WHERE rn.tenant_id = $2))`, [id, TENANT, `req-${status}`, uuid(), status]);
      return id;
    }
    function baseUrl(): string {
      const a = app.getHttpServer().address();
      return `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`;
    }
    async function postPipeline(jwt: string, reqId: string, overrideReason?: string): Promise<Response> {
      return fetch(`${baseUrl()}/v1/pipelines?site_id=${SITE}`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ talent_record_id: uuid(), requisition_id: reqId, site_id: SITE, ...(overrideReason === undefined ? {} : { override_reason_code: overrideReason }) }) });
    }
    async function postSourcing(jwt: string, reqId: string, overrideReason?: string): Promise<Response> {
      return fetch(`${baseUrl()}/v1/sourcing/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ref_type: 'SOURCED_TALENT', ref_id: uuid(), requisition_id: reqId, ...(overrideReason === undefined ? {} : { override_reason_code: overrideReason }) }) });
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await ensureWriteFreezeTenant((s) => db.query(s), TENANT);
      for (const cap of ['ats', 'core']) await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [TENANT, cap]);

      storePrisma = new PolicyStorePrismaService(url);
      await storePrisma.$connect();
      store = new PolicyStore(storePrisma);
      // Publish the REAL restrictive matrix (v2.0.0) for this tenant.
      await store.publish({ tenant_id: TENANT, definition: REQUISITION_LIFECYCLE_PACKAGE, published_by: SYSTEM_PUBLISHER });

      const kp = await generateKeyPair(ALG);
      signingKey = kp.privateKey as SignKey;
      const pem = await exportSPKI(kp.publicKey as never);
      savedEnv = { DATABASE_URL: process.env['DATABASE_URL'], AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'], AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'] };
      process.env['DATABASE_URL'] = url; process.env['AUTH_AUDIENCE'] = AUDIENCE; process.env['AUTH_PUBLIC_KEY'] = pem;

      const mod: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = mod.createNestApplication();
      app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
      await app.init();
      await app.listen(0);
    }, 120_000);

    afterAll(async () => {
      await app?.close();
      await storePrisma?.onModuleDestroy();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }, 60_000);

    it('EVERY cell (24) evaluates per the matrix against the PUBLISHED + RETRIEVED package', async () => {
      const resolved = await store.getActiveVersion(TENANT, PKG_NAME);
      expect(resolved?.version).toBe('3.0.0');
      for (const [status, row] of Object.entries(EXPECTED)) {
        for (const [resource, expected] of Object.entries(row)) {
          const d = evaluate(resolved!.definition, contextFor(status, resource));
          expect(d.decision, `${status}·${resource}`).toBe(expected);
          if (expected === 'REQUIRES_OVERRIDE') {
            expect(d.required_capabilities, `${status}·${resource} cap`).toEqual([OVERRIDE_CAP]);
          }
        }
      }
    });

    describe('ADD column over HTTP — both boundaries honour ONE rulebook', () => {
      const base = ['pipeline:add', 'talent:source'];
      const withCap = ['pipeline:add', 'talent:source', OVERRIDE_CAP];

      it('active -> pipeline 201; closed -> 403 DENY', async () => {
        expect((await postPipeline(await signJwt(base), await seedRequisition('active'))).status).toBe(201);
        expect((await postPipeline(await signJwt(base), await seedRequisition('closed'))).status).toBe(403);
      });

      it('full + Add, capability ABSENT -> 403 DENY (pipeline + sourcing)', async () => {
        expect((await postPipeline(await signJwt(base), await seedRequisition('full'))).status).toBe(403);
        expect((await postSourcing(await signJwt(base), await seedRequisition('full'), 'replacement')).status).toBe(403);
      });

      it('full + Add, capability present + valid reason -> ALLOWS and mutates (pipeline 201; sourcing proceeds → 200 deferral)', async () => {
        const reqP = await seedRequisition('full');
        expect((await postPipeline(await signJwt(withCap), reqP, 'client_approved_overfill')).status).toBe(201);
        const reqS = await seedRequisition('full');
        expect((await postSourcing(await signJwt(withCap), reqS, 'duplicate_correction')).status).toBe(200);
      });
    });

    it('§D17b — a decision made under an earlier version still names it after v2.0.0 is republished (re-read from the DB)', async () => {
      const T = '01900000-0000-7000-8000-0000000000f6';
      await ensureWriteFreezeTenant((s) => db.query(s), T);
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1,'ats') ON CONFLICT DO NOTHING`, [T]);
      // v1.0.0 published first, active window; make a decision under it.
      await store.publish({ tenant_id: T, definition: { ...REQUISITION_LIFECYCLE_PACKAGE, version: '1.0.0' }, published_by: SYSTEM_PUBLISHER, effective_from: new Date('2026-01-01T00:00:00Z') });
      const req = uuid();
      await db.query(`INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, status, requisition_number) VALUES ($1,$2,'r',$3,'active', (SELECT COALESCE(MAX(rn.requisition_number),999)+1 FROM requisition."Requisition" rn WHERE rn.tenant_id = $2))`, [req, T, uuid()]);
      const jwt = await new SignJWT({ sub: ACTOR, consumer_type: 'recruiter', actor_kind: 'user', tenant_id: T, site_id: SITE, scopes: ['pipeline:add'] })
        .setProtectedHeader({ alg: ALG }).setIssuedAt().setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime('1h').sign(signingKey);
      expect((await postPipeline(jwt, req)).status).toBe(201);
      const first = (await db.query(`SELECT id, policy_version FROM policy_store."PolicyDecisionRecord" WHERE tenant_id=$1 ORDER BY occurred_at DESC LIMIT 1`, [T])).rows[0];
      expect(first.policy_version).toBe('1.0.0');
      // Republish v2.0.0 (later window); the earlier record must STILL name 1.0.0.
      await store.publish({ tenant_id: T, definition: { ...REQUISITION_LIFECYCLE_PACKAGE, version: '2.0.0' }, published_by: SYSTEM_PUBLISHER, effective_from: new Date('2026-06-01T00:00:00Z') });
      const reread = (await db.query(`SELECT policy_version FROM policy_store."PolicyDecisionRecord" WHERE id=$1`, [first.id])).rows[0];
      expect(reread.policy_version).toBe('1.0.0');
    });
  },
);
