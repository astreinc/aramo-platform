import { readFileSync } from 'node:fs';
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

// ADR-0024 PR-3 — the first policy-engine consumer, E2E over REQUISITION_TALENT
// · ADD (POST /v1/pipelines). Real Postgres 17; skipped unless
// ARAMO_RUN_INTEGRATION=1.
//
// Proves: (1) an ALLOW add creates the pipeline row AND a §D17a
// PolicyDecisionRecord carrying the REAL policy_version + rule_id; (2) PR-4c —
// the ADD column of the RESTRICTIVE MATRIX v2.0.0 (active/on_hold/lead ALLOW;
// full REQUIRES_OVERRIDE → 403 without the capability; closed/canceled DENY →
// 403); (3) a provenance-write failure on ALLOW rolls the pipeline row back
// (atomic, §D10). The override-capability path + the Submit/Note/Document
// columns live in policy-matrix.integration.spec.ts.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');
const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-policy-add-talent-spec';
const ALG = 'RS256';

const TENANT = '01900000-0000-7000-8000-0000000000c3';
const SITE = '33333333-3333-7333-8333-3333333333cc';
const ACTOR = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaac3';
const ADD_SCOPES = ['pipeline:add'];

const M = (p: string): string => resolve(ROOT, p);
const MIGRATIONS = [
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
  'libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql',
  'libs/requisition/prisma/migrations/20260603140100_add_import_batch_id_to_requisition/migration.sql',
  'libs/requisition/prisma/migrations/20260605123400_add_compensation_fields_to_requisition/migration.sql',
  'libs/requisition/prisma/migrations/20260611220000_job_module_requisition_fields/migration.sql',
  'libs/requisition/prisma/migrations/20260803120000_recruiting_status_supersession/migration.sql',
  'libs/pipeline/prisma/migrations/20260602150000_init_pipeline_model/migration.sql',
  // Track 3 E6 — total unique -> live-scoped partial unique.
  'libs/pipeline/prisma/migrations/20260807100000_e6_pipeline_live_episode_unique/migration.sql',
  'libs/pipeline/prisma/migrations/20260827120000_l2a_pipeline_version_column/migration.sql',
  // L2-B — append-only history trigger; nullable status_from + ended_at/ended_by_id; pipeline OutboxEvent.
  'libs/pipeline/prisma/migrations/20260828100000_l2b_pipeline_history_append_only/migration.sql',
  'libs/pipeline/prisma/migrations/20260828110000_l2b_pipeline_ended_at_nullable_status_from/migration.sql',
  'libs/pipeline/prisma/migrations/20260828120000_l2b_pipeline_outbox_event/migration.sql',
  'libs/pipeline/prisma/migrations/20260828130000_l2c_pipeline_qualified_completed_enum/migration.sql',
  'libs/pipeline/prisma/migrations/20260828140000_l2c_pipeline_live_episode_recreate/migration.sql',
  'libs/pipeline/prisma/migrations/20260828150000_l2c_pipeline_disposition/migration.sql',
  // ADR-0024 PR-3 — the create transaction writes here.
  'libs/policy-store/prisma/migrations/20260730120000_init_policy_store/migration.sql',
  'libs/policy-store/prisma/migrations/20260730160000_add_policy_decision_record/migration.sql',
  // L2-B — the consent-schema IdempotencyKey table backs the required Idempotency-Key on create.
  'libs/consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql',
].map(M);

// PR-4a — the package is RETRIEVED from policy-store, not overridden via a DI
// token (deleted). ALLOW tests publish the real lifecycle package for their
// tenant; the DENY here is the ONLY denial the shipped configuration can
// produce — the fail-closed no-published-package path. Restrictive-rule DENY
// (closed → DENY, full → REQUIRES_OVERRIDE) arrives in PR-4c.

const SIX_STATES = ['open', 'on_hold', 'submittals_closed', 'closed', 'canceled', 'lead'] as const;

let uuidCounter = 0;
function uuid(): string {
  uuidCounter += 1;
  const h = uuidCounter.toString(16).padStart(12, '0');
  return `00000000-0000-7000-8000-${h}`;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PR-3 policy consumer — REQUISITION_TALENT · ADD (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let signingKey: SignKey;
    let savedEnv: Partial<Record<string, string | undefined>> = {};

    async function signJwt(scopes: string[]): Promise<string> {
      return new SignJWT({
        sub: ACTOR,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: TENANT,
        site_id: SITE,
        scopes,
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(signingKey);
    }

    // Raw-seed a Requisition with a chosen declared status (company_id has no FK).
    async function seedRequisition(status: string): Promise<string> {
      const id = uuid();
      await db.query(
        `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, status)
         VALUES ($1, $2, $3, $4, $5::"requisition"."RecruitingStatus")`,
        [id, TENANT, `req-${status}`, uuid(), status],
      );
      return id;
    }

    async function buildApp(): Promise<INestApplication> {
      const mod: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
      const app = mod.createNestApplication();
      app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
      await app.init();
      await app.listen(0);
      return app;
    }

    function baseUrl(app: INestApplication): string {
      const url = app.getHttpServer().address();
      const p = typeof url === 'object' && url !== null ? url.port : 0;
      return `http://127.0.0.1:${p}`;
    }

    async function postAdd(app: INestApplication, jwt: string, requisitionId: string): Promise<Response> {
      return fetch(`${baseUrl(app)}/v1/pipelines?site_id=${SITE}`, {
        method: 'POST',
        // L2-B — POST /v1/pipelines now requires a UUID Idempotency-Key.
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', 'Idempotency-Key': uuid() },
        body: JSON.stringify({ talent_record_id: uuid(), requisition_id: requisitionId, site_id: SITE }),
      });
    }

    // E6 B-http-one-live — POST for a SPECIFIC talent (not a fresh uuid), so a
    // second call targets the SAME (tenant, talent, requisition) live triple.
    async function postAddTalent(app: INestApplication, jwt: string, requisitionId: string, talentId: string): Promise<Response> {
      return fetch(`${baseUrl(app)}/v1/pipelines?site_id=${SITE}`, {
        method: 'POST',
        // L2-B — POST /v1/pipelines now requires a UUID Idempotency-Key. A fresh key
        // per call keeps the two same-triple POSTs distinct operations (so the second
        // still hits the E6 live-episode 409, not an idempotent replay).
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', 'Idempotency-Key': uuid() },
        body: JSON.stringify({ talent_record_id: talentId, requisition_id: requisitionId, site_id: SITE }),
      });
    }

    async function pipelineCount(requisitionId: string): Promise<number> {
      const r = await db.query(`SELECT count(*)::int AS n FROM pipeline."Pipeline" WHERE requisition_id = $1`, [requisitionId]);
      return r.rows[0].n as number;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await ensureWriteFreezeTenant((s) => db.query(s), TENANT);
      await db.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1, 'ats')
         ON CONFLICT DO NOTHING`,
        [TENANT],
      );
      // PR-4a — the package is now RETRIEVED from policy-store; publish it for
      // this tenant so ALLOW resolves instead of failing closed.
      await publishLifecyclePackage(url, TENANT);

      const kp = await generateKeyPair(ALG);
      signingKey = kp.privateKey as SignKey;
      const publicPem = await exportSPKI(kp.publicKey as never);
      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;
    }, 120_000);

    afterAll(async () => {
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }, 60_000);

    describe('shipped permissive package', () => {
      let app: INestApplication;
      beforeAll(async () => { app = await buildApp(); });
      afterAll(async () => { await app?.close(); });

      it('an ALLOW add creates the pipeline row AND records provenance with the real version + rule_id', async () => {
        const req = await seedRequisition('open');
        const jwt = await signJwt(ADD_SCOPES);
        const res = await postAdd(app, jwt, req);
        expect(res.status).toBe(201);
        expect(await pipelineCount(req)).toBe(1);

        const recs = (await db.query(
          `SELECT decision, policy_version, rule_id FROM policy_store."PolicyDecisionRecord" WHERE actor_id = $1 AND decision = 'ALLOW' ORDER BY occurred_at DESC LIMIT 1`,
          [ACTOR],
        )).rows;
        expect(recs).toHaveLength(1);
        expect(recs[0].policy_version).toBe('6.0.0'); // T1-e (v6.0.0)
        expect(recs[0].rule_id).toBe('add-talent-open');
      });

      // PR-4c — the ADD column of the restrictive matrix. active/on_hold/lead
      // ALLOW (201 + row); full → REQUIRES_OVERRIDE, which without the override
      // capability refuses (403); closed/canceled → DENY (403). The override
      // capability path + the Submit/Note/Document columns are in the matrix E2E.
      it('the ADD column of the restrictive matrix is enforced per state', async () => {
        const jwt = await signJwt(ADD_SCOPES); // no override capability
        const expectAllow = new Set(['open', 'on_hold', 'lead']);
        for (const status of SIX_STATES) {
          const req = await seedRequisition(status);
          const res = await postAdd(app, jwt, req);
          if (expectAllow.has(status)) {
            expect(res.status, `state=${status}`).toBe(201);
            expect(await pipelineCount(req), `state=${status} row`).toBe(1);
            const rec = (await db.query(
              `SELECT rule_id FROM policy_store."PolicyDecisionRecord" WHERE actor_id=$1 ORDER BY occurred_at DESC LIMIT 1`, [ACTOR],
            )).rows[0];
            expect(rec.rule_id, `state=${status} rule`).toBe(`add-talent-${status}`);
          } else {
            // full (REQUIRES_OVERRIDE, no capability) + closed/canceled (DENY) → 403.
            expect(res.status, `state=${status}`).toBe(403);
            expect(await pipelineCount(req), `state=${status} no row`).toBe(0);
          }
        }
      });

      // ---- E6 B-http-one-live (Q-2, §4.1) ----
      // POST /v1/pipelines twice for the SAME live triple: the first creates the
      // live episode (201); the second is refused deterministically with 409 +
      // PIPELINE_EPISODE_ALREADY_LIVE (never a leaked Prisma/SQL uniqueness error),
      // and NO second row persists. Uses the existing pipeline:add authority — no
      // new scope.
      it('B-http-one-live: a second POST for the same live triple is refused 409 PIPELINE_EPISODE_ALREADY_LIVE; no second row', async () => {
        const req = await seedRequisition('open');
        const jwt = await signJwt(ADD_SCOPES);
        const talent = uuid();

        const first = await postAddTalent(app, jwt, req, talent);
        expect(first.status).toBe(201);
        expect(await pipelineCount(req)).toBe(1);

        const second = await postAddTalent(app, jwt, req, talent);
        expect(second.status).toBe(409);
        const body = (await second.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe('PIPELINE_EPISODE_ALREADY_LIVE');

        expect(await pipelineCount(req)).toBe(1); // no second row
      });

      it('ATOMICITY: a provenance-write failure on ALLOW rolls back the pipeline row (no row persists)', async () => {
        const req = await seedRequisition('open');
        const jwt = await signJwt(ADD_SCOPES);
        // Force the in-tx provenance INSERT to fail — AFTER tx.pipeline.create,
        // which is what makes this a rollback test and not a pre-write short
        // circuit. Renaming the table makes insertPolicyDecisionRecordInTx throw
        // ("relation does not exist") inside the same transaction.
        await db.query(`ALTER TABLE policy_store."PolicyDecisionRecord" RENAME TO "PolicyDecisionRecord_atomicity"`);
        try {
          const res = await postAdd(app, jwt, req);
          expect(res.status).toBeGreaterThanOrEqual(500);
          expect(await pipelineCount(req)).toBe(0); // rolled back
        } finally {
          await db.query(`ALTER TABLE policy_store."PolicyDecisionRecord_atomicity" RENAME TO "PolicyDecisionRecord"`);
        }
      });
    });

    // The DENY / REQUIRES_OVERRIDE describes moved to the fail-closed path in
    // policy-retrieval.integration.spec.ts: PR-4a deletes the DI-token override,
    // and restrictive-rule DENY (closed → DENY, full → REQUIRES_OVERRIDE) is
    // PR-4c. The only denial the shipped config produces now is no-published-
    // package fail-closed, covered there.
  },
);
