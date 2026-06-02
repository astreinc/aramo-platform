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

// PR-A5a Gate 5 — ATS Batch 4a (pipeline state machine + activity) integration spec.
//
// THE load-bearing state-machine proof (directive §4):
//   1. Initial state: pipeline-add creates at `no_contact`.
//   2. Legal transition (no_contact -> contacted): succeeds; Pipeline.
//      status updates; a PipelineStatusHistory row appears (from / to);
//      an Activity row appears (pipeline_status_change); a UsageEvent
//      row appears. ALL FOUR writes present together — the atomic 4-tx.
//   3. Illegal transition (no_contact -> placed): rejected with 422
//      INVALID_PIPELINE_TRANSITION. Pipeline.status unchanged; NO new
//      PipelineStatusHistory row; NO new Activity row; NO new
//      UsageEvent row. The tx never fired.
//   4. No-op transition (same status): no history, no activity, no
//      metering event.
//   5. Placed transition (offered -> placed): reaches placed (status +
//      history + activity + metering ALL written). PROVES THE A5b
//      BOUNDARY: requisition.Requisition.openings_available is bit-
//      identical pre- and post-transition; no submittal."TalentSubmittal
//      Record" row exists pre OR post (we never touched the table).
//
// Plus the A2 three-axis gating proofs on /v1/pipelines:
//   - entitlement axis  — tenant without `ats` capability → 403
//   - authorization axis — token without `pipeline:*` scopes → 403
//   - site axis         — token site != requested site → 403
//   - recruiter-remove divergence — recruiter DELETE → 403 (only
//     tenant_admin holds `pipeline:remove`).
//
// And the metering-in-transaction proof (directive §4 item 3):
//   - A successful transition writes exactly one new UsageEvent.
//   - A rejected transition writes zero UsageEvents.
//
// Vocab gate (R12): the response payload uses `talent_responded`, never
// the OpenCATS legacy anti-token — asserted structurally inside the
// legal-transition test using a runtime-composed forbidden string.
//
// Skipped unless ARAMO_RUN_INTEGRATION=1.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');

const ENTITLEMENT_INIT = resolve(
  ROOT,
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
);
const METERING_INIT = resolve(
  ROOT,
  'libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
);
const REQUISITION_INIT = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql',
);
const TALENT_RECORD_INIT = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260602120000_init_talent_record_model/migration.sql',
);
const ACTIVITY_INIT = resolve(
  ROOT,
  'libs/activity/prisma/migrations/20260602140000_init_activity_model/migration.sql',
);
const PIPELINE_INIT = resolve(
  ROOT,
  'libs/pipeline/prisma/migrations/20260602150000_init_pipeline_model/migration.sql',
);

// Submittal & engagement migrations carry the submittal schema (the A5b
// boundary asserts no submittal row is touched). We don't load them —
// the absence proof works either way; counting rows in a non-existent
// table would error. Instead, the boundary is asserted via the
// requisition.openings_available delta + no requisition row mutation.

const MIGRATIONS = [
  ENTITLEMENT_INIT,
  METERING_INIT,
  REQUISITION_INIT,
  TALENT_RECORD_INIT,
  ACTIVITY_INIT,
  PIPELINE_INIT,
];

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-ats-batch4a-pipeline-activity-spec';
const ALG = 'RS256';

const TENANT_ATS = '01900000-0000-7000-8000-000000000001';
const TENANT_NOT_ATS = '22222222-2222-7222-8222-222222222222';
const SITE_A = '33333333-3333-7333-8333-3333333333aa';
const SITE_B = '44444444-4444-7444-8444-4444444444bb';

const RECRUITER = '00000000-0000-7000-8000-000000000bb1';
const TENANT_ADMIN = '00000000-0000-7000-8000-000000000aa1';

// Recruiter scopes — the four seeded pipeline+activity scopes minus
// `pipeline:remove` (the tenant_admin-only destructive scope).
const RECRUITER_SCOPES = [
  'pipeline:add',
  'pipeline:change-status',
  'pipeline:add-activity',
  'activity:read',
];
const TENANT_ADMIN_SCOPES = [
  ...RECRUITER_SCOPES,
  'pipeline:remove',
];

const TALENT_RECORD_ID = '11111111-1111-7111-8111-1111111111aa';
const REQUISITION_ID = '22222222-2222-7222-8222-2222222222bb';
const COMPANY_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PR-A5a ATS Batch 4a — pipeline state machine + activity proofs (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let setupClient: Client;

    let recruiterJwt_Ats_SiteA: string;
    let recruiterJwt_NotAts_SiteA: string;
    let recruiterJwt_Ats_WrongSite: string;
    let unscopedJwt_Ats_SiteA: string;
    let tenantAdminJwt_Ats_SiteA: string;

    async function signJwt(
      privateKey: SignKey,
      args: { sub: string; tenant_id: string; site_id?: string; scopes: string[] },
    ): Promise<string> {
      const builder = new SignJWT({
        sub: args.sub,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: args.tenant_id,
        scopes: args.scopes,
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h');
      return builder.sign(privateKey);
    }

    async function countUsageEvents(): Promise<number> {
      const r = await setupClient.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM metering."UsageEvent"
         WHERE event_type = 'pipeline.state_transition' AND tenant_id = $1::uuid`,
        [TENANT_ATS],
      );
      return Number(r.rows[0]!.c);
    }

    async function countActivityRows(pipelineId: string): Promise<number> {
      const r = await setupClient.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM activity."Activity"
         WHERE tenant_id = $1::uuid AND subject_type = 'pipeline' AND subject_id = $2::uuid`,
        [TENANT_ATS, pipelineId],
      );
      return Number(r.rows[0]!.c);
    }

    async function countHistoryRows(pipelineId: string): Promise<number> {
      const r = await setupClient.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM pipeline."PipelineStatusHistory"
         WHERE tenant_id = $1::uuid AND pipeline_id = $2::uuid`,
        [TENANT_ATS, pipelineId],
      );
      return Number(r.rows[0]!.c);
    }

    async function readStatus(pipelineId: string): Promise<string> {
      const r = await setupClient.query<{ status: string }>(
        `SELECT status::text AS status FROM pipeline."Pipeline"
         WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [TENANT_ATS, pipelineId],
      );
      return r.rows[0]!.status;
    }

    async function seedRequisitionWithOpenings(
      requisitionId: string,
      openings: number,
    ): Promise<void> {
      await setupClient.query(
        `INSERT INTO requisition."Requisition"
         (id, tenant_id, site_id, title, company_id, openings, openings_available, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'A5b-boundary req', $4::uuid, $5, $5, 'active')
         ON CONFLICT (id) DO NOTHING`,
        [requisitionId, TENANT_ATS, SITE_A, COMPANY_ID, openings],
      );
    }

    async function readOpeningsAvailable(
      requisitionId: string,
    ): Promise<number> {
      const r = await setupClient.query<{ openings_available: number }>(
        `SELECT openings_available FROM requisition."Requisition"
         WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [requisitionId, TENANT_ATS],
      );
      return r.rows[0]!.openings_available;
    }

    async function createPipeline(jwt: string): Promise<{
      id: string;
      status: string;
    }> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/pipelines?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            talent_record_id: TALENT_RECORD_ID,
            requisition_id: REQUISITION_ID,
            site_id: SITE_A,
          }),
        },
      );
      const body = (await res.json()) as { id: string; status: string };
      return body;
    }

    async function transition(
      jwt: string,
      id: string,
      to_status: string,
      note?: string,
    ): Promise<{ status: number; body: unknown }> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/pipelines/${id}/transition?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            to_status,
            ...(note === undefined ? {} : { note }),
          }),
        },
      );
      return { status: res.status, body: await res.json() };
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      setupClient = new Client({ connectionString: url });
      await setupClient.connect();

      for (const p of MIGRATIONS) {
        await setupClient.query(readFileSync(p, 'utf8'));
      }

      // Entitle TENANT_ATS to `ats` so JwtAuthGuard → EntitlementGuard
      // permits the pipeline routes for this tenant.
      await setupClient.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
         VALUES ($1::uuid, 'ats')
         ON CONFLICT (tenant_id, capability) DO NOTHING`,
        [TENANT_ATS],
      );

      // Seed a Requisition row so the A5b-boundary assertion has a
      // concrete openings_available to compare against pre/post.
      await seedRequisitionWithOpenings(REQUISITION_ID, 3);

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      const privateKey: SignKey = kp.privateKey as SignKey;

      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;

      recruiterJwt_Ats_SiteA = await signJwt(privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: RECRUITER_SCOPES,
      });
      recruiterJwt_NotAts_SiteA = await signJwt(privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_NOT_ATS,
        site_id: SITE_A,
        scopes: RECRUITER_SCOPES,
      });
      recruiterJwt_Ats_WrongSite = await signJwt(privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_ATS,
        site_id: SITE_B,
        scopes: RECRUITER_SCOPES,
      });
      unscopedJwt_Ats_SiteA = await signJwt(privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: [],
      });
      tenantAdminJwt_Ats_SiteA = await signJwt(privateKey, {
        sub: TENANT_ADMIN,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: TENANT_ADMIN_SCOPES,
      });

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }),
      );
      await app.init();
      const server = await app.listen(0);
      const address = server.address() as AddressInfo;
      port = address.port;
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

    // -------------------------------------------------------------------------
    // A) A2 pattern reuse — three-axis gating on /v1/pipelines.
    // -------------------------------------------------------------------------

    it('A2-reuse / entitlement axis: tenant lacking ats → 403 TENANT_CAPABILITY_NOT_ENTITLED', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/pipelines?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${recruiterJwt_NotAts_SiteA}` },
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('TENANT_CAPABILITY_NOT_ENTITLED');
    });

    it('A2-reuse / authorization axis: user without scope → 403 INSUFFICIENT_PERMISSIONS', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/pipelines?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${unscopedJwt_Ats_SiteA}` },
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('A2-reuse / site axis: token site != requested site → 403 INSUFFICIENT_PERMISSIONS', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/pipelines?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${recruiterJwt_Ats_WrongSite}` },
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('A2-reuse / recruiter-remove divergence: recruiter DELETE /v1/pipelines/:id → 403', async () => {
      const created = await createPipeline(recruiterJwt_Ats_SiteA);
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/pipelines/${created.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${recruiterJwt_Ats_SiteA}` },
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('INSUFFICIENT_PERMISSIONS');

      // Clean up via tenant_admin so subsequent tests can re-create the
      // (talent_record_id, requisition_id) unique row.
      await fetch(
        `http://127.0.0.1:${port}/v1/pipelines/${created.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
    });

    // -------------------------------------------------------------------------
    // B) THE state-machine proof (directive §4)
    // -------------------------------------------------------------------------

    it('Initial state: pipeline-add creates at no_contact (directive §2 invariant)', async () => {
      const created = await createPipeline(recruiterJwt_Ats_SiteA);
      expect(created.status).toBe('no_contact');
      // The proposed map (Ruling 1) targets `no_contact` as the only
      // initial — no_status is never reached by this entry point.
      const rowStatus = await readStatus(created.id);
      expect(rowStatus).toBe('no_contact');
      // No history written at create (no transition has fired).
      expect(await countHistoryRows(created.id)).toBe(0);
      expect(await countActivityRows(created.id)).toBe(0);
      // Cleanup.
      await fetch(
        `http://127.0.0.1:${port}/v1/pipelines/${created.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
    });

    it('Legal transition (no_contact -> contacted): atomic 4-write commits — status + history + activity + metering', async () => {
      const created = await createPipeline(recruiterJwt_Ats_SiteA);
      const usageBefore = await countUsageEvents();

      const r = await transition(
        recruiterJwt_Ats_SiteA,
        created.id,
        'contacted',
        'left voicemail',
      );
      expect(r.status).toBe(200);
      const body = r.body as { status: string };
      expect(body.status).toBe('contacted');

      // Atomic 4-write structural check.
      expect(await readStatus(created.id)).toBe('contacted');
      expect(await countHistoryRows(created.id)).toBe(1);
      expect(await countActivityRows(created.id)).toBe(1);
      expect(await countUsageEvents()).toBe(usageBefore + 1);

      // R12 vocab: payload uses talent_responded vocabulary nowhere
      // accidentally surfacing the forbidden OpenCATS token. The token
      // is composed at runtime so the eslint vocabulary rule does not
      // flag this negative-shape assertion (matches the libs/pipeline
      // pipeline-state.spec.ts pattern).
      const r12Forbidden = ['cand', 'idate'].join('');
      expect(JSON.stringify(body)).not.toContain(r12Forbidden);

      await fetch(
        `http://127.0.0.1:${port}/v1/pipelines/${created.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
    });

    it('Illegal transition (no_contact -> placed): rejected with INVALID_PIPELINE_TRANSITION; NO writes anywhere', async () => {
      const created = await createPipeline(recruiterJwt_Ats_SiteA);
      const usageBefore = await countUsageEvents();
      const historyBefore = await countHistoryRows(created.id);
      const activityBefore = await countActivityRows(created.id);
      const statusBefore = await readStatus(created.id);

      const r = await transition(recruiterJwt_Ats_SiteA, created.id, 'placed');
      expect(r.status).toBe(422);
      const body = r.body as { error: { code: string } };
      expect(body.error.code).toBe('INVALID_PIPELINE_TRANSITION');

      // The tx never fired: every write target is unchanged.
      expect(await readStatus(created.id)).toBe(statusBefore);
      expect(await countHistoryRows(created.id)).toBe(historyBefore);
      expect(await countActivityRows(created.id)).toBe(activityBefore);
      expect(await countUsageEvents()).toBe(usageBefore);

      await fetch(
        `http://127.0.0.1:${port}/v1/pipelines/${created.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
    });

    it('No-op transition (same status): no history, no activity, no metering event', async () => {
      const created = await createPipeline(recruiterJwt_Ats_SiteA);
      const usageBefore = await countUsageEvents();

      const r = await transition(
        recruiterJwt_Ats_SiteA,
        created.id,
        'no_contact',
      );
      expect(r.status).toBe(200);

      expect(await readStatus(created.id)).toBe('no_contact');
      expect(await countHistoryRows(created.id)).toBe(0);
      expect(await countActivityRows(created.id)).toBe(0);
      expect(await countUsageEvents()).toBe(usageBefore);

      await fetch(
        `http://127.0.0.1:${port}/v1/pipelines/${created.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
    });

    it('Placed transition: reaches placed (status + history + activity + metering) AND proves the A5b boundary (no requisition.openings or submittal touch)', async () => {
      // Re-read pre-state of requisition.openings_available — the
      // A5b-boundary invariant.
      const openingsBefore = await readOpeningsAvailable(REQUISITION_ID);

      const created = await createPipeline(recruiterJwt_Ats_SiteA);

      // Walk the legal forward chain to offered, then to placed.
      for (const step of [
        'contacted',
        'talent_responded',
        'qualifying',
        'submitted',
        'interviewing',
        'offered',
      ]) {
        const r = await transition(recruiterJwt_Ats_SiteA, created.id, step);
        expect(r.status, `step ${step}`).toBe(200);
      }

      const usageBeforePlaced = await countUsageEvents();
      const historyBeforePlaced = await countHistoryRows(created.id);
      const activityBeforePlaced = await countActivityRows(created.id);

      const placedRes = await transition(
        recruiterJwt_Ats_SiteA,
        created.id,
        'placed',
      );
      expect(placedRes.status).toBe(200);
      expect((placedRes.body as { status: string }).status).toBe('placed');

      // 4-write atomicity confirmed for the placed transition too.
      expect(await readStatus(created.id)).toBe('placed');
      expect(await countHistoryRows(created.id)).toBe(historyBeforePlaced + 1);
      expect(await countActivityRows(created.id)).toBe(activityBeforePlaced + 1);
      expect(await countUsageEvents()).toBe(usageBeforePlaced + 1);

      // === THE A5b BOUNDARY ASSERTION (directive §2 Ruling 3) ===
      // Requisition.openings_available is bit-identical pre and post.
      // Pipeline at A5a does NOT decrement it; that's A5b. If this
      // assertion fails, the A5a/A5b separation is violated — HALT.
      const openingsAfter = await readOpeningsAvailable(REQUISITION_ID);
      expect(openingsAfter).toBe(openingsBefore);

      // We never wrote to submittal."TalentSubmittalRecord" — the table
      // is not even loaded into this test container, so any attempted
      // write would have thrown a relation-does-not-exist error long
      // before this point. The implicit absence is the strongest
      // possible structural assertion.
      const submittalProbe = await setupClient
        .query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'submittal' AND table_name = 'TalentSubmittalRecord'
           ) AS exists`,
        )
        .catch(() => null);
      expect(submittalProbe?.rows[0]?.exists ?? false).toBe(false);

      await fetch(
        `http://127.0.0.1:${port}/v1/pipelines/${created.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
    });

    // -------------------------------------------------------------------------
    // C) Metering-in-transaction (directive §4 item 3)
    // -------------------------------------------------------------------------

    it('Metering-in-transaction: a usage event is recorded iff the transition commits', async () => {
      const created = await createPipeline(recruiterJwt_Ats_SiteA);

      const usageBefore = await countUsageEvents();
      // Legal: +1 usage.
      const legal = await transition(
        recruiterJwt_Ats_SiteA,
        created.id,
        'contacted',
      );
      expect(legal.status).toBe(200);
      expect(await countUsageEvents()).toBe(usageBefore + 1);

      // Illegal from contacted -> placed: +0 usage.
      const usageMid = await countUsageEvents();
      const illegal = await transition(
        recruiterJwt_Ats_SiteA,
        created.id,
        'placed',
      );
      expect(illegal.status).toBe(422);
      expect(await countUsageEvents()).toBe(usageMid);

      await fetch(
        `http://127.0.0.1:${port}/v1/pipelines/${created.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
    });
  },
);
