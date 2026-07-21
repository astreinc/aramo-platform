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

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

// PR-A7 Gate 5 — ATS-INTERNAL reporting + dashboard integration spec.
//
// Proof matrix:
//   A) A2 three-axis gating on /v1/reports/* and /v1/dashboard
//      (entitlement / authz / site reject).
//   B) Metric correctness — seed known ATS data → counts + rollups
//      return the expected values.
//   C) Role-visibility (the A3 shape) — recruiter sees own-assigned
//      reqs/pipelines only; tenant_admin sees tenant-wide.
//   D) THE SEAM-EXCLUSION (structural):
//      - The test container is set up with ONLY the 8 ATS-side
//        schemas applied (company / contact / requisition / pipeline /
//        activity / calendar / saved_list / talent_record /
//        entitlement). NO engagement / submittal / examination /
//        matching / talent / job_domain migration is applied. If the
//        reporting service touched ANY Core schema, every call would
//        500 with "relation does not exist". All metric calls return
//        200 → the service truly reads no Core schema.
//      - Additionally, the dashboard payload structurally includes
//        `placement.includes_core_submittal_placements: false` — the
//        explicit documentation of the seam.
//
// Skipped unless ARAMO_RUN_INTEGRATION=1.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');

const ENTITLEMENT_INIT = resolve(
  ROOT,
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
);
const COMPANY_INIT = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260601160000_init_company_model/migration.sql',
);
const COMPANY_FIELD_EXPANSION = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260611000000_add_company_field_expansion/migration.sql',
);
const COMPANY_ADDRESS_PLACE_REF = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260611120000_add_company_address_place_ref/migration.sql',
);
const COMPANY_OFF_LIMITS = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260616000000_add_company_off_limits/migration.sql',
);
const CONTACT_INIT = resolve(
  ROOT,
  'libs/contact/prisma/migrations/20260601160000_init_contact_model/migration.sql',
);
const REQUISITION_INIT = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql',
);
const TALENT_RECORD_INIT = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260602120000_init_talent_record_model/migration.sql',
);
const TALENT_RECORD_LINK_ADD = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260603020000_add_core_talent_link_to_talent_record/migration.sql',
);
const ACTIVITY_INIT = resolve(
  ROOT,
  'libs/activity/prisma/migrations/20260602140000_init_activity_model/migration.sql',
);
const PIPELINE_INIT = resolve(
  ROOT,
  'libs/pipeline/prisma/migrations/20260602150000_init_pipeline_model/migration.sql',
);
const CALENDAR_INIT = resolve(
  ROOT,
  'libs/calendar/prisma/migrations/20260602120000_init_calendar_model/migration.sql',
);
const SAVED_LIST_INIT = resolve(
  ROOT,
  'libs/saved-list/prisma/migrations/20260602120000_init_saved_list_model/migration.sql',
);
// Promotion-Trigger slice-A — list_kind column (regenerated SavedList client SELECTs it).
const SAVED_LIST_LIST_KIND = resolve(
  ROOT,
  'libs/saved-list/prisma/migrations/20260706130000_add_list_kind_tenant_bench/migration.sql',
);
// metering is required because PipelineRepository.transition writes a
// UsageEvent row inside the same tx (PR-A1c). We don't transition any
// pipelines in this spec, so the table just needs to exist for the
// schema to be valid; we do not seed it.
const METERING_INIT = resolve(
  ROOT,
  'libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
);
// PR-A8-1 — additive back-reference columns on the 4 ATS targets.
// The Prisma client's RETURNING projection includes import_batch_id;
// absent in DB → 500 INTERNAL_ERROR on POST create.
const COMPANY_IMPORT_BACK_REF = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260603140100_add_import_batch_id_to_company/migration.sql',
);
const CONTACT_IMPORT_BACK_REF = resolve(
  ROOT,
  'libs/contact/prisma/migrations/20260603140100_add_import_batch_id_to_contact/migration.sql',
);
const CONTACT_LIST_SURFACE_FIELDS = resolve(
  ROOT,
  'libs/contact/prisma/migrations/20260618120000_add_contact_list_surface_fields/migration.sql',
);
const REQUISITION_IMPORT_BACK_REF = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260603140100_add_import_batch_id_to_requisition/migration.sql',
);
// Compensation-Field Modeling v1.1 — 2 enums + 10 nullable comp cols.
const REQUISITION_COMPENSATION_FIELDS = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260605123400_add_compensation_fields_to_requisition/migration.sql',
);
// Job-Module — enterprise + financial + golden_profile_id columns. The
// repository's RETURNING projection includes them; absent in DB → 500 on
// every requisition write/read (the documented migration-harness gap:
// per-spec MIGRATIONS lists are hardcoded, not auto-discovered).
const REQUISITION_JOB_MODULE_FIELDS = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260611220000_job_module_requisition_fields/migration.sql',
);
// New Requisition (Requisition Record Spec Amendment v1.0) — rate_type +
// allow_subcontractors + run_match_on_create. Additive; applied last.
const REQUISITION_RATE_TYPE_SUBK = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260618120000_add_rate_type_subk_runmatch/migration.sql',
);
const REQUISITION_PUBLISH_SURFACE_MIGRATION = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260721000000_add_publish_surface/migration.sql',
);
const TALENT_RECORD_IMPORT_BACK_REF = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260603140100_add_import_batch_id_to_talent_record/migration.sql',
);
// Segment 2 — the talent-stated availability_status + engagement_type columns
// (Prisma create RETURNING projects them; the test DB must carry them).
const TALENT_RECORD_STATED_FIELDS = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260615000000_talent_stated_fields/migration.sql',
);
// 4d — overlay-fold columns + cluster_id (TalentRecord RETURNING projects them).
const TALENT_RECORD_OVERLAY_FOLD = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260630140000_overlay_fold_cluster_id/migration.sql',
);
// Gate-1 G1-A — work_authorization column (regenerated client projects it).
const TALENT_RECORD_WORK_AUTH = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260702120000_add_work_authorization_to_talent_record/migration.sql',
);
// TR-2a-B3a (DDR-3 §3) — record_status / superseded_* columns (regenerated client
// projects them; TalentRecord RETURNING/findFirst 500s without them).
const TALENT_RECORD_SUPERSESSION = resolve(
  ROOT,
  'libs/talent-record/prisma/migrations/20260706210000_tr2a_b3a_talent_record_supersession/migration.sql',
);

// === CORE / ENGAGEMENT / SUBMITTAL MIGRATIONS — DELIBERATELY OMITTED ===
//
// This spec applies ONLY the 8 ATS-side schemas + entitlement +
// metering. The engagement / submittal / examination / matching /
// talent / job_domain schemas are NOT created in the test container.
// If ReportingService or any controller it depends on were to issue a
// query against any of those schemas, the route would 500 with
// `relation "engagement.Engagement" does not exist` (or similar). The
// fact that every metric route returns 200 is the seam-exclusion
// proof: A7 reads no Core schema.

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-ats-batch6-reporting-dashboard-spec';
const ALG = 'RS256';

const TENANT_ATS = '01900000-0000-7000-8000-000000000001';
const TENANT_NOT_ATS = '22222222-2222-7222-8222-222222222222';
const SITE_A = '33333333-3333-7333-8333-3333333333aa';
const SITE_B = '44444444-4444-7444-8444-4444444444bb';

const RECRUITER = '00000000-0000-7000-8000-000000000bb1';
const RECRUITER_OTHER = '00000000-0000-7000-8000-000000000bb2';
const TENANT_ADMIN = '00000000-0000-7000-8000-000000000aa1';

const REPORT_RECRUITER_SCOPES = [
  'report:read',
  'dashboard:read',
  // The reporting service needs to resolve the actor's visible
  // requisitions via RequisitionRepository.listForActor — which is
  // gated by `requisition:read`. (NOT `:read:all` — recruiter divergence.)
  'requisition:read',
  // For seeding helpers below — exercise the existing create scopes.
  'company:create',
  'contact:create',
  'talent:create',
  'requisition:create',
  'requisition:assign',
  'pipeline:add',
  'pipeline:change-status',
  'activity:create',
  'calendar:event-create',
  'saved-list:create',
];
const REPORT_TENANT_ADMIN_SCOPES = [
  ...REPORT_RECRUITER_SCOPES,
  'requisition:read:all', // the A3 see-all proxy
];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PR-A7 ATS finishers — reporting + dashboard proofs (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let setupClient: Client;

    let recruiterJwt: string;
    let recruiterOtherJwt: string;
    let recruiterJwt_NotAts: string;
    let recruiterJwt_WrongSite: string;
    let unscopedJwt: string;
    let tenantAdminJwt: string;

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

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      setupClient = new Client({ connectionString: url });
      await setupClient.connect();

      // Apply ONLY ATS-side migrations + entitlement + metering. See the
      // header note: the absence of engagement/submittal/examination/etc.
      // is the seam-exclusion structural proof.
      for (const p of [
        ENTITLEMENT_INIT,
        COMPANY_INIT,
        COMPANY_FIELD_EXPANSION,
        COMPANY_ADDRESS_PLACE_REF,
        COMPANY_OFF_LIMITS,
        COMPANY_IMPORT_BACK_REF,
        CONTACT_INIT,
        CONTACT_IMPORT_BACK_REF,
        CONTACT_LIST_SURFACE_FIELDS,
        REQUISITION_INIT,
        REQUISITION_IMPORT_BACK_REF,
        REQUISITION_COMPENSATION_FIELDS, REQUISITION_JOB_MODULE_FIELDS, REQUISITION_RATE_TYPE_SUBK, REQUISITION_PUBLISH_SURFACE_MIGRATION,
        TALENT_RECORD_INIT,
        TALENT_RECORD_LINK_ADD,
        TALENT_RECORD_IMPORT_BACK_REF,
        TALENT_RECORD_STATED_FIELDS,
        TALENT_RECORD_OVERLAY_FOLD,
        TALENT_RECORD_WORK_AUTH,
        TALENT_RECORD_SUPERSESSION,
        ACTIVITY_INIT,
        PIPELINE_INIT,
        CALENDAR_INIT,
        SAVED_LIST_INIT,
        SAVED_LIST_LIST_KIND,
        METERING_INIT,
      ]) {
        await setupClient.query(readFileSync(p, 'utf8'));
      }

      // Inc-3 PR-3.7 — the global write-freeze interceptor reads identity.Tenant
      // status on every mutation; seed an ACTIVE tenant for each forged tenant_id.
      await ensureWriteFreezeTenant((s) => setupClient.query(s), TENANT_ATS);
      await ensureWriteFreezeTenant((s) => setupClient.query(s), TENANT_NOT_ATS);

      await setupClient.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
         VALUES ($1::uuid, 'ats')
         ON CONFLICT (tenant_id, capability) DO NOTHING`,
        [TENANT_ATS],
      );

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

      recruiterJwt = await signJwt(privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: REPORT_RECRUITER_SCOPES,
      });
      recruiterOtherJwt = await signJwt(privateKey, {
        sub: RECRUITER_OTHER,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: REPORT_RECRUITER_SCOPES,
      });
      recruiterJwt_NotAts = await signJwt(privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_NOT_ATS,
        site_id: SITE_A,
        scopes: REPORT_RECRUITER_SCOPES,
      });
      recruiterJwt_WrongSite = await signJwt(privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_ATS,
        site_id: SITE_B,
        scopes: REPORT_RECRUITER_SCOPES,
      });
      unscopedJwt = await signJwt(privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: [],
      });
      tenantAdminJwt = await signJwt(privateKey, {
        sub: TENANT_ADMIN,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: REPORT_TENANT_ADMIN_SCOPES,
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

      // Seed: 2 companies, 1 contact, 2 talent_records, 2 requisitions
      // (1 assigned to the recruiter, 1 NOT assigned), 1 saved-list,
      // 1 calendar event, plus 1 pipeline on the assigned req.
      const companyA = await postJson('/v1/companies', tenantAdminJwt, {
        name: 'Co A',
        site_id: SITE_A,
      });
      await postJson('/v1/companies', tenantAdminJwt, {
        name: 'Co B',
        site_id: SITE_A,
      });
      await postJson('/v1/contacts', tenantAdminJwt, {
        company_id: companyA.id,
        first_name: 'Con',
        last_name: 'Tact',
        email1: 'c@x.example',
        site_id: SITE_A,
      });
      await postJson('/v1/talent-records', tenantAdminJwt, {
        first_name: 'T',
        last_name: 'One',
        site_id: SITE_A,
      });
      await postJson('/v1/talent-records', tenantAdminJwt, {
        first_name: 'T',
        last_name: 'Two',
        site_id: SITE_A,
      });

      const reqAssigned = await postJson('/v1/requisitions', tenantAdminJwt, {
        title: 'Assigned to recruiter',
        company_id: companyA.id,
        site_id: SITE_A,
      });
      const reqUnassigned = await postJson('/v1/requisitions', tenantAdminJwt, {
        title: 'Unassigned to recruiter',
        company_id: companyA.id,
        site_id: SITE_A,
      });
      void reqUnassigned;
      // Assign reqAssigned to RECRUITER via the tenant_admin assign route.
      await postJson(
        `/v1/requisitions/${reqAssigned.id}/assignments`,
        tenantAdminJwt,
        { user_id: RECRUITER, site_id: SITE_A },
      );

      // Create a pipeline on the assigned req (talent_record_id can be any).
      const aTalent = await postJson('/v1/talent-records', tenantAdminJwt, {
        first_name: 'Pipe',
        last_name: 'Subject',
        site_id: SITE_A,
      });
      await postJson('/v1/pipelines', recruiterJwt, {
        requisition_id: reqAssigned.id,
        talent_record_id: aTalent.id,
        site_id: SITE_A,
      });

      await postJson('/v1/saved-lists', tenantAdminJwt, {
        name: 'Report list',
        item_type: 'talent_record',
        site_id: SITE_A,
      });
      await postJson('/v1/calendar-events', tenantAdminJwt, {
        type: 'meeting',
        title: 'Future meeting',
        starts_at: '2030-01-01T10:00:00Z',
        site_id: SITE_A,
      });
      await postJson('/v1/activities', tenantAdminJwt, {
        type: 'note',
        notes: 'recent',
        site_id: SITE_A,
      });
    }, 240_000);

    async function postJson(
      path: string,
      jwt: string,
      body: unknown,
    ): Promise<{ id: string }> {
      const res = await fetch(
        `http://127.0.0.1:${port}${path}?site_id=${SITE_A}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
      if (res.status < 200 || res.status >= 300) {
        const text = await res.text();
        throw new Error(`POST ${path} -> ${res.status} ${text}`);
      }
      return (await res.json()) as { id: string };
    }

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
    // A) Three-axis gating reuse on the report + dashboard routes.
    // -------------------------------------------------------------------------

    it('entitlement axis: tenant lacking ats → 403 TENANT_CAPABILITY_NOT_ENTITLED', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/reports/tenant-counts?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${recruiterJwt_NotAts}` },
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('TENANT_CAPABILITY_NOT_ENTITLED');
    });

    it('authorization axis: unscoped → 403 INSUFFICIENT_PERMISSIONS', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/reports/tenant-counts?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${unscopedJwt}` },
        },
      );
      expect(res.status).toBe(403);
    });

    it('site axis: token site != requested site → 403', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/reports/tenant-counts?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${recruiterJwt_WrongSite}` },
        },
      );
      expect(res.status).toBe(403);
    });

    it('dashboard entitlement + authz: same gating shape', async () => {
      const r1 = await fetch(
        `http://127.0.0.1:${port}/v1/dashboard?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${recruiterJwt_NotAts}` },
        },
      );
      expect(r1.status).toBe(403);
      const r2 = await fetch(
        `http://127.0.0.1:${port}/v1/dashboard?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${unscopedJwt}` },
        },
      );
      expect(r2.status).toBe(403);
    });

    // -------------------------------------------------------------------------
    // B) Metric correctness — tenant_admin sees tenant-wide truth.
    // -------------------------------------------------------------------------

    it('GET /v1/reports/tenant-counts — tenant_admin sees the seeded counts', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/reports/tenant-counts?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${tenantAdminJwt}` },
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        companies: number;
        contacts: number;
        talent_records: number;
        saved_lists: number;
        calendar_events: number;
        activities: number;
      };
      // Seed: 2 companies, 1 contact, 3 talent_records (One/Two/Subject),
      // 1 saved-list, 1 calendar event, 1+ activities.
      expect(body.companies).toBe(2);
      expect(body.contacts).toBe(1);
      expect(body.talent_records).toBe(3);
      expect(body.saved_lists).toBe(1);
      expect(body.calendar_events).toBe(1);
      expect(body.activities).toBeGreaterThanOrEqual(1);
    });

    it('GET /v1/reports/requisition-rollup — tenant_admin sees tenant-wide total = 2', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/reports/requisition-rollup?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${tenantAdminJwt}` },
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        total: number;
        by_status: Array<{ status: string; count: number }>;
      };
      expect(body.total).toBe(2);
      expect(Array.isArray(body.by_status)).toBe(true);
    });

    it('GET /v1/reports/pipeline-rollup — tenant_admin sees the seeded 1-pipeline', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/reports/pipeline-rollup?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${tenantAdminJwt}` },
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        total: number;
        by_status: Array<{ status: string; count: number }>;
      };
      expect(body.total).toBe(1);
    });

    it('GET /v1/reports/placement-count — 0 placements + the seam-exclusion flag is exposed', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/reports/placement-count?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${tenantAdminJwt}` },
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        placed_pipelines: number;
        includes_core_submittal_placements: boolean;
      };
      expect(body.placed_pipelines).toBe(0); // none transitioned to placed
      // The dashboard's seam-disclosure flag is wired through here too.
      expect(body.includes_core_submittal_placements).toBe(false);
    });

    // -------------------------------------------------------------------------
    // C) Role-visibility (the A3 shape): recruiter sees only assigned reqs;
    //    tenant_admin sees tenant-wide.
    // -------------------------------------------------------------------------

    it('Role-visibility — recruiter requisition-rollup.total = 1 (own assignment); tenant_admin = 2 (tenant-wide)', async () => {
      const recRes = await fetch(
        `http://127.0.0.1:${port}/v1/reports/requisition-rollup?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${recruiterJwt}` },
        },
      );
      expect(recRes.status).toBe(200);
      const recBody = (await recRes.json()) as { total: number };
      expect(recBody.total).toBe(1);

      const adminRes = await fetch(
        `http://127.0.0.1:${port}/v1/reports/requisition-rollup?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${tenantAdminJwt}` },
        },
      );
      const adminBody = (await adminRes.json()) as { total: number };
      expect(adminBody.total).toBe(2);
    });

    it('Role-visibility — a DIFFERENT recruiter (no assignment) sees requisition-rollup.total = 0', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/reports/requisition-rollup?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${recruiterOtherJwt}` },
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { total: number };
      expect(body.total).toBe(0);
    });

    it('Role-visibility — recruiter pipeline-rollup.total = 1 (the pipeline is on their assigned req); the unassigned recruiter sees 0', async () => {
      const rec = await fetch(
        `http://127.0.0.1:${port}/v1/reports/pipeline-rollup?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${recruiterJwt}` },
        },
      );
      const recBody = (await rec.json()) as { total: number };
      expect(recBody.total).toBe(1);

      const other = await fetch(
        `http://127.0.0.1:${port}/v1/reports/pipeline-rollup?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${recruiterOtherJwt}` },
        },
      );
      const otherBody = (await other.json()) as { total: number };
      expect(otherBody.total).toBe(0);
    });

    // -------------------------------------------------------------------------
    // D) THE SEAM-EXCLUSION — structural proof.
    // -------------------------------------------------------------------------

    it('Seam-exclusion: GET /v1/dashboard returns 200 even though engagement/submittal/examination/talent/job_domain schemas are NOT applied to the container', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/dashboard?site_id=${SITE_A}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${tenantAdminJwt}` },
        },
      );
      // If the reporting service touched any Core schema, this would
      // 500 with `relation "engagement.X" does not exist`.
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        tenant_counts: { companies: number };
        requisition_rollup: { total: number };
        pipeline_rollup: { total: number };
        placement: {
          placed_pipelines: number;
          includes_core_submittal_placements: boolean;
        };
        upcoming_events: unknown[];
        recent_activity: unknown[];
      };
      expect(body.tenant_counts.companies).toBe(2);
      expect(body.requisition_rollup.total).toBe(2);
      expect(body.pipeline_rollup.total).toBe(1);
      // The explicit seam disclosure in the payload.
      expect(body.placement.includes_core_submittal_placements).toBe(false);
      expect(Array.isArray(body.upcoming_events)).toBe(true);
      expect(Array.isArray(body.recent_activity)).toBe(true);
    });

    it('Seam-exclusion: every individual /v1/reports/* route returns 200 without any Core schema applied', async () => {
      for (const path of [
        '/v1/reports/tenant-counts',
        '/v1/reports/requisition-rollup',
        '/v1/reports/pipeline-rollup',
        '/v1/reports/placement-count',
      ]) {
        const res = await fetch(
          `http://127.0.0.1:${port}${path}?site_id=${SITE_A}`,
          {
            method: 'GET',
            headers: { Authorization: `Bearer ${tenantAdminJwt}` },
          },
        );
        expect(res.status, `${path} should return 200`).toBe(200);
      }
    });
  },
);
