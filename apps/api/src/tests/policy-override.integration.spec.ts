import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey, type KeyObject } from 'jose';
import {
  PolicyStore,
  PrismaService as PolicyStorePrismaService,
  type PublishPolicyVersionInput,
} from '@aramo/policy-store';

import { AppModule } from '../app.module.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

// ADR-0024 §D11 (PR-4b) — the two-pass override, E2E over BOTH command
// boundaries: POST /v1/pipelines and POST /v1/sourcing/pipeline. Real Postgres
// 17; skipped unless ARAMO_RUN_INTEGRATION=1.

type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../..');
const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-policy-override-spec';
const ALG = 'RS256';
const TENANT = '01900000-0000-7000-8000-0000000000f1';
const SITE = '33333333-3333-7333-8333-3333333333f1';
const ACTOR = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaf1';
const SYSTEM_PUBLISHER = '00000000-0000-0000-0000-000000000000';

// The engine-named override capability (§D11, SCOPE 6). Canonical vocab: the
// directive's colloquial name is a Tier-2-banned term (scripts/verify-
// vocabulary.sh) — translated to `submittal`.
const OVERRIDE_CAP = 'requisition.override.submittal_closed';

// TEST-ONLY package. PR-4b needs a rule that produces REQUIRES_OVERRIDE to drive
// the two-pass flow; the SHIPPED package is still permissive (the restrictive
// matrix is PR-4c). This is NOT a restrictive matrix — it exists only to exercise
// the override path: `active` ALLOWs, `full` requires an override.
const OVERRIDE_PACKAGE: PublishPolicyVersionInput['definition'] = {
  name: 'requisition-lifecycle',
  version: '1.0.0',
  registry: { resources: ['REQUISITION_TALENT'], actions: ['ADD'] },
  default_disposition: { decision: 'ALLOW', reason_code: 'DEFAULT_ALLOW' },
  rules: [
    {
      id: 'add-talent-active',
      resource: 'REQUISITION_TALENT',
      action: 'ADD',
      when: [{ source: 'declared', key: 'status', op: 'eq', value: 'open' }],
      decision: 'ALLOW',
      reason_code: 'ACTIVE_ALLOWED',
    },
    {
      id: 'add-talent-full',
      resource: 'REQUISITION_TALENT',
      action: 'ADD',
      when: [{ source: 'declared', key: 'status', op: 'eq', value: 'submittals_closed' }],
      decision: 'REQUIRES_OVERRIDE',
      reason_code: 'SUBMITTAL_CLOSED_OVERRIDE_REQUIRED',
      required_capability: OVERRIDE_CAP,
      effects: [{ kind: 'REQUIRE_REASON' }],
    },
  ],
};

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
  // L2-B — the consent-schema IdempotencyKey table backs the required Idempotency-Key on create.
  resolve(ROOT, 'libs/consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql'),
];

let uuidCounter = 0;
function uuid(): string {
  uuidCounter += 1;
  return `00000000-0000-7000-8000-${uuidCounter.toString(16).padStart(12, '0')}`;
}

async function publishOverridePackage(url: string, tenant: string): Promise<void> {
  const prisma = new PolicyStorePrismaService(url);
  await prisma.$connect();
  try {
    await new PolicyStore(prisma).publish({
      tenant_id: tenant,
      definition: OVERRIDE_PACKAGE,
      published_by: SYSTEM_PUBLISHER,
    });
  } finally {
    await prisma.onModuleDestroy();
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PR-4b override (§D11) — both boundaries (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let signingKey: SignKey;
    let app: INestApplication;
    let savedEnv: Partial<Record<string, string | undefined>> = {};

    async function signJwt(scopes: string[]): Promise<string> {
      return new SignJWT({ sub: ACTOR, consumer_type: 'recruiter', actor_kind: 'user', tenant_id: TENANT, site_id: SITE, scopes })
        .setProtectedHeader({ alg: ALG }).setIssuedAt().setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime('1h').sign(signingKey);
    }
    async function seedRequisition(status: string): Promise<string> {
      const id = uuid();
      await db.query(
        `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, status, requisition_number) VALUES ($1,$2,$3,$4,$5::"requisition"."RecruitingStatus", (SELECT COALESCE(MAX(rn.requisition_number),999)+1 FROM requisition."Requisition" rn WHERE rn.tenant_id = $2))`,
        [id, TENANT, `req-${status}`, uuid(), status],
      );
      return id;
    }
    function baseUrl(): string {
      const a = app.getHttpServer().address();
      return `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`;
    }
    async function postPipeline(jwt: string, reqId: string, overrideReason?: string): Promise<Response> {
      return fetch(`${baseUrl()}/v1/pipelines?site_id=${SITE}`, {
        method: 'POST',
        // L2-B — POST /v1/pipelines now requires a UUID Idempotency-Key.
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', 'Idempotency-Key': uuid() },
        body: JSON.stringify({ talent_record_id: uuid(), requisition_id: reqId, site_id: SITE, ...(overrideReason === undefined ? {} : { override_reason_code: overrideReason }) }),
      });
    }
    async function postSourcing(jwt: string, reqId: string, overrideReason?: string): Promise<Response> {
      return fetch(`${baseUrl()}/v1/sourcing/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref_type: 'SOURCED_TALENT', ref_id: uuid(), requisition_id: reqId, ...(overrideReason === undefined ? {} : { override_reason_code: overrideReason }) }),
      });
    }
    async function pipelineCount(reqId: string): Promise<number> {
      return (await db.query(`SELECT count(*)::int n FROM pipeline."Pipeline" WHERE requisition_id=$1`, [reqId])).rows[0].n;
    }
    async function latestRecord(): Promise<{ decision: string; reason_code: string; inputs: { override?: { reason_code: string; capabilities: string[] } } }> {
      return (await db.query(`SELECT decision, reason_code, inputs FROM policy_store."PolicyDecisionRecord" WHERE actor_id=$1 ORDER BY occurred_at DESC LIMIT 1`, [ACTOR])).rows[0];
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await ensureWriteFreezeTenant((s) => db.query(s), TENANT);
      for (const cap of ['ats', 'core']) {
        await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [TENANT, cap]);
      }
      await publishOverridePackage(url, TENANT);

      const kp = await generateKeyPair(ALG);
      signingKey = kp.privateKey as SignKey;
      const pem = await exportSPKI(kp.publicKey as never);
      savedEnv = { DATABASE_URL: process.env['DATABASE_URL'], AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'], AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'] };
      process.env['DATABASE_URL'] = url;
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

    describe('POST /v1/pipelines', () => {
      const base = ['pipeline:add'];
      const withCap = ['pipeline:add', OVERRIDE_CAP];

      it('ALLOW path unchanged — active status still 201, row created (regression)', async () => {
        const req = await seedRequisition('open');
        expect((await postPipeline(await signJwt(base), req)).status).toBe(201);
        expect(await pipelineCount(req)).toBe(1);
      });

      it('REQUIRES_OVERRIDE + capability ABSENT -> 403 POLICY_DENIED, no row, provenance records the attempt', async () => {
        const req = await seedRequisition('submittals_closed');
        const res = await postPipeline(await signJwt(base), req, 'replacement');
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error?: { code?: string; details?: { reason_code?: string } } };
        expect(body.error?.code).toBe('POLICY_DENIED');
        expect(body.error?.details?.reason_code).toBe('SUBMITTAL_CLOSED_OVERRIDE_REQUIRED');
        expect(await pipelineCount(req)).toBe(0);
        expect((await latestRecord()).decision).toBe('REQUIRES_OVERRIDE'); // the attempt
      });

      it('REQUIRES_OVERRIDE + capability present + NO reason -> 422 OVERRIDE_INVALID, no row', async () => {
        const req = await seedRequisition('submittals_closed');
        const res = await postPipeline(await signJwt(withCap), req);
        expect(res.status).toBe(422);
        expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('OVERRIDE_INVALID');
        expect(await pipelineCount(req)).toBe(0);
      });

      it('REQUIRES_OVERRIDE + capability + INVALID reason code -> 422 OVERRIDE_INVALID, no row', async () => {
        const req = await seedRequisition('submittals_closed');
        const res = await postPipeline(await signJwt(withCap), req, 'not_a_real_code');
        expect(res.status).toBe(422);
        expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('OVERRIDE_INVALID');
        expect(await pipelineCount(req)).toBe(0);
      });

      it('FULL PATH — capability + valid reason -> 201; the ORIGINAL proposal is disposed; provenance carries reason_code + capability', async () => {
        const req = await seedRequisition('submittals_closed');
        const res = await postPipeline(await signJwt(withCap), req, 'client_approved_overfill');
        expect(res.status).toBe(201); // same POST /v1/pipelines — no new endpoint (§D6)
        expect(await pipelineCount(req)).toBe(1); // the original add proposal proceeded
        const rec = await latestRecord();
        expect(rec.decision).toBe('REQUIRES_OVERRIDE'); // engine's real verdict retained
        expect(rec.inputs.override).toEqual({
          reason_code: 'client_approved_overfill',
          capabilities: [OVERRIDE_CAP],
        });
      });
    });

    describe('POST /v1/sourcing/pipeline (second boundary)', () => {
      const base = ['talent:source'];
      const withCap = ['talent:source', OVERRIDE_CAP];

      it('REQUIRES_OVERRIDE + capability ABSENT -> 403 POLICY_DENIED', async () => {
        const req = await seedRequisition('submittals_closed');
        const res = await postSourcing(await signJwt(base), req, 'replacement');
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('POLICY_DENIED');
      });

      it('REQUIRES_OVERRIDE + capability + NO reason -> 422 OVERRIDE_INVALID', async () => {
        const req = await seedRequisition('submittals_closed');
        const res = await postSourcing(await signJwt(withCap), req);
        expect(res.status).toBe(422);
        expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('OVERRIDE_INVALID');
      });

      it('FULL PATH — capability + valid reason -> override satisfied, flow proceeds (200 deferral); provenance carries reason_code + capability', async () => {
        const req = await seedRequisition('submittals_closed');
        const res = await postSourcing(await signJwt(withCap), req, 'duplicate_correction');
        expect(res.status).toBe(200); // the override resolved; promotion defers on the unknown subject
        const rec = await latestRecord();
        expect(rec.decision).toBe('REQUIRES_OVERRIDE');
        expect(rec.inputs.override).toEqual({
          reason_code: 'duplicate_correction',
          capabilities: [OVERRIDE_CAP],
        });
      });
    });
  },
);
