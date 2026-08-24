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
import { publishLifecyclePackage } from './publish-lifecycle-package.js';

// PR-A5a Gate 5 — ATS Batch 4a (pipeline state machine + activity)
// integration spec.
//
// T4-B2 UPDATE (§7): the pipeline->requisition capacity coupling that
// PR-A5b-1 once layered onto section (D) has been RETIRED. The
// `placed`-transition decrement of requisition.openings_available, its
// REQUISITION_NO_OPENINGS over-capacity 409 guard, AND the delete-
// restore (+1) were all DELETED from the pipeline writer. Capacity
// availability is now DERIVED (openings - active ContractAssignment
// count); over-capacity is REPRESENTABLE and is never a pipeline-time
// refusal. The `placed` transition is once again a FOUR-write atomic tx
// (status + history + activity + metering) that leaves requisition
// capacity UNTOUCHED. Accordingly the two former over-capacity tests
// (PR-A5b-1 §5 (i) and (ii)/(iii)) are DELETED, and the placed-
// transition test now proves capacity is NOT mutated (neither by the
// transition nor by the subsequent delete).
//
// THE load-bearing state-machine proof (PR-A5a directive §4):
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
//   5. Placed transition (offered -> placed) — T4-B2: reaches placed
//      (status + history + activity + metering ALL written) and does
//      NOT mutate requisition.openings_available (the B2 writer removal),
//      and a subsequent delete does NOT restore any slot. The Core
//      boundaries hold: no submittal."TalentSubmittalRecord" row exists
//      pre OR post (we never touched that table).
//
// Section (D) below retains ONLY the no-Core-touch structural boundary
// proof: talent.* / examination.* / submittal.* / job_domain.* schemas
// remain ABSENT (not even loaded into this container), so any write into
// them would have thrown long before the assertion.
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
// PR-A5b-2 — additive core_talent_id column. Applied AFTER
// TALENT_RECORD_INIT so the ALTER TABLE finds its target. Required
// here (even though A5a/A5b-1 don't exercise the link) for schema
// parity — the live Prisma client compiled against the schema expects
// the column to exist.
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
// Track 3 E6 — total unique -> live-scoped partial unique.
const PIPELINE_E6 = resolve(
  ROOT,
  'libs/pipeline/prisma/migrations/20260807100000_e6_pipeline_live_episode_unique/migration.sql',
);
// ADR-0024 PR-3 — POST /v1/pipelines writes §D17a provenance into
// policy_store."PolicyDecisionRecord" in the create transaction (init creates
// the schema).
const POLICY_STORE_INIT = resolve(
  ROOT,
  'libs/policy-store/prisma/migrations/20260730120000_init_policy_store/migration.sql',
);
const POLICY_DECISION_RECORD = resolve(
  ROOT,
  'libs/policy-store/prisma/migrations/20260730160000_add_policy_decision_record/migration.sql',
);
// PR-A8-1 — additive back-reference columns on requisition +
// talent_record. The Prisma client's RETURNING projection includes
// import_batch_id; absent in DB → 500 INTERNAL_ERROR on POST create.
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
// Requisition-expander enrichment (LOCKED Aramo-Requisition-Expander-Talent-
// Rate-Columns v1.0) — the GET /v1/pipelines enrichment composer reads
// consent."TalentConsentEvent" (scope='contacting') to gate contact-channel
// (email/phone) disclosure. HARNESS-REQUIRED: absent these two migrations, the
// composer's consent read 500s (relation consent."TalentConsentEvent" does not
// exist) for any talent:read-bearing caller. Registration is provable — both
// files exist under libs/consent/prisma/migrations. `rekey` renames the row key
// talent_id -> talent_record_id (the shape the composer queries by).
const CONSENT_INIT = resolve(
  ROOT,
  'libs/consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql',
);
const CONSENT_REKEY_TO_TALENT_RECORD = resolve(
  ROOT,
  'libs/consent/prisma/migrations/20260630170000_rekey_consent_to_talent_record/migration.sql',
);

// Submittal & selection migrations carry the submittal schema (the A5b
// boundary asserts no submittal row is touched). We don't load them —
// the absence proof works either way; counting rows in a non-existent
// table would error. Instead, the boundary is asserted structurally via
// information_schema (those schemas are never loaded into this
// container). Note (T4-B2): the DROP-openings_available migration is
// deliberately NOT in the MIGRATIONS list below, so the stored column
// remains present in this container and can still be read to prove the
// pipeline writer no longer mutates it.

const MIGRATIONS = [
  ENTITLEMENT_INIT,
  METERING_INIT,
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
  PIPELINE_E6,
  POLICY_STORE_INIT,
  POLICY_DECISION_RECORD,
  resolve(ROOT, 'libs/requisition/prisma/migrations/20260803120000_recruiting_status_supersession/migration.sql'),
  CONSENT_INIT,
  CONSENT_REKEY_TO_TALENT_RECORD,
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

// Recruiter scopes — full recruiter+ pipeline+activity set minus
// `pipeline:remove` (the tenant_admin-only destructive scope).
// HK-IDENT-SCOPES seeds `pipeline:read` + `activity:create` as proper
// scopes (recruiter+); read routes / activity POST key on them
// instead of the prior `pipeline:add` / `pipeline:add-activity`
// superset expedients.
const RECRUITER_SCOPES = [
  'pipeline:read',
  'pipeline:add',
  'pipeline:change-status',
  'pipeline:add-activity',
  'activity:read',
  'activity:create',
];
const TENANT_ADMIN_SCOPES = [
  ...RECRUITER_SCOPES,
  'pipeline:remove',
];

const TALENT_RECORD_ID = '11111111-1111-7111-8111-1111111111aa';
const REQUISITION_ID = '22222222-2222-7222-8222-2222222222bb';
const COMPANY_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

// Requisition-expander enrichment token scopes. pipeline:read gates the LIST
// route; requisition:read:all makes resolveVisibleRequisitionIds → null (see-
// all) so the seeded rows come back; talent:read is the R-LAYERING EXISTENCE
// gate for the five enrichment fields. The no-talent variant keeps identical
// visibility but omits talent:read — proving the existence gate nulls the
// fields regardless of consent.
const ENRICH_SCOPES_WITH_TALENT = [
  'pipeline:read',
  'talent:read',
  'requisition:read:all',
];
const ENRICH_SCOPES_NO_TALENT = ['pipeline:read', 'requisition:read:all'];

// Enrichment fixtures — kept distinct from the state-machine ids above so the
// two suites never contend on the (talent_record_id, requisition_id) unique.
const ENRICH_TALENT_CONTACTABLE = '55555555-5555-7555-8555-555555555501';
const ENRICH_TALENT_DNC = '55555555-5555-7555-8555-555555555502';
const ENRICH_TALENT_CROSS_TENANT = '55555555-5555-7555-8555-555555555503';
const ENRICH_PIPE_CONTACTABLE = '66666666-6666-7666-8666-666666666601';
const ENRICH_PIPE_DNC = '66666666-6666-7666-8666-666666666602';
const ENRICH_PIPE_CROSS_TENANT = '66666666-6666-7666-8666-666666666603';

// Shape of a GET /v1/pipelines list item, narrowed to the enrichment fields
// under test (the five are optional on PipelineView — absent/null when the
// existence gate or a missing record applies).
type PipelineViewLike = {
  talent_record_id: string;
  email?: string | null;
  phone?: string | null;
  location?: string | null;
  work_auth?: string | null;
  desired_rate?: string | null;
};

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
    let enrichJwt_WithTalent: string;
    let enrichJwt_NoTalent: string;

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
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'A5b-boundary req', $4::uuid, $5, $5, 'open')
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

    // Requisition-expander enrichment fixtures. Two live TalentRecords in
    // TENANT_ATS carry full contact fields; one CONTACTABLE (contacting grant),
    // one with NO consent event (default-deny → do_not_contact). A third
    // TalentRecord lives in TENANT_NOT_ATS to prove cross-tenant contact fields
    // never leak. Three pipelines (all TENANT_ATS, on the seeded requisition,
    // visible via requisition:read:all) reference the three talents. Rows are
    // seeded by direct SQL so no metering/policy side effects perturb the
    // state-machine counters asserted elsewhere in this suite.
    async function seedEnrichmentFixtures(): Promise<void> {
      await setupClient.query(
        `INSERT INTO talent_record."TalentRecord"
           (id, tenant_id, first_name, last_name, email1, phone_cell,
            city, state, work_authorization, desired_pay)
         VALUES
           ($1::uuid, $2::uuid, 'Dana', 'Rivera', 'dana.rivera@example.com',
            '+1-512-555-0101', 'Austin', 'TX', 'us_citizen', '$85/hr'),
           ($3::uuid, $2::uuid, 'Priya', 'Nair', 'priya.nair@example.com',
            '+1-206-555-0102', 'Seattle', 'WA', 'green_card', '$92/hr')
         ON CONFLICT (id) DO NOTHING`,
        [ENRICH_TALENT_CONTACTABLE, TENANT_ATS, ENRICH_TALENT_DNC],
      );
      await setupClient.query(
        `INSERT INTO talent_record."TalentRecord"
           (id, tenant_id, first_name, last_name, email1, phone_cell,
            city, state, work_authorization, desired_pay)
         VALUES
           ($1::uuid, $2::uuid, 'Other', 'Tenant', 'do-not-leak@example.com',
            '+1-000-555-0000', 'Elsewhere', 'ZZ', 'us_citizen', '$999/hr')
         ON CONFLICT (id) DO NOTHING`,
        [ENRICH_TALENT_CROSS_TENANT, TENANT_NOT_ATS],
      );
      // Contacting GRANT for the contactable talent → 'contactable'
      // (expires_at NULL ⇒ not expiring). The DNC talent gets no event.
      await setupClient.query(
        `INSERT INTO consent."TalentConsentEvent"
           (id, talent_record_id, tenant_id, scope, action, captured_method,
            consent_version, occurred_at, expires_at)
         VALUES
           (gen_random_uuid(), $1::uuid, $2::uuid, 'contacting', 'granted',
            'web', 'v1', NOW(), NULL)`,
        [ENRICH_TALENT_CONTACTABLE, TENANT_ATS],
      );
      await setupClient.query(
        `INSERT INTO pipeline."Pipeline"
           (id, tenant_id, site_id, talent_record_id, requisition_id, status)
         VALUES
           ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'contacted'),
           ($6::uuid, $2::uuid, $3::uuid, $7::uuid, $5::uuid, 'contacted'),
           ($8::uuid, $2::uuid, $3::uuid, $9::uuid, $5::uuid, 'contacted')
         ON CONFLICT (id) DO NOTHING`,
        [
          ENRICH_PIPE_CONTACTABLE,
          TENANT_ATS,
          SITE_A,
          ENRICH_TALENT_CONTACTABLE,
          REQUISITION_ID,
          ENRICH_PIPE_DNC,
          ENRICH_TALENT_DNC,
          ENRICH_PIPE_CROSS_TENANT,
          ENRICH_TALENT_CROSS_TENANT,
        ],
      );
    }

    // Narrowed GET /v1/pipelines list (by talent_record_id) — deterministic:
    // returns exactly the fixture's pipeline row regardless of other suites'
    // residue. Passes through the real enrichment interceptor.
    async function listPipelinesForTalent(
      jwt: string,
      talentId: string,
    ): Promise<PipelineViewLike[]> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/pipelines?site_id=${SITE_A}&talent_record_id=${talentId}`,
        { method: 'GET', headers: { Authorization: `Bearer ${jwt}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: PipelineViewLike[] };
      return body.items;
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

    async function walkToOffered(jwt: string, id: string): Promise<void> {
      for (const step of ['contacted', 'talent_responded', 'qualifying']) {
        const r = await transition(jwt, id, step);
        expect(r.status, `walkToOffered step ${step}`).toBe(200);
      }
      // L8-B1 R-TIGHTEN — `submitted` is no longer reachable through the transition
      // route (it is the submit-to-ats orchestrator's mirror). Set it directly, as
      // the orchestrator does, then continue the engine chain to offered.
      await setupClient.query(
        `UPDATE pipeline."Pipeline" SET status = 'submitted' WHERE id = $1::uuid`,
        [id],
      );
      for (const step of ['interviewing', 'offered']) {
        const r = await transition(jwt, id, step);
        expect(r.status, `walkToOffered step ${step}`).toBe(200);
      }
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

      // Inc-3 PR-3.7 — the global write-freeze interceptor reads identity.Tenant
      // status on every mutation; seed an ACTIVE tenant for each forged tenant_id.
      await ensureWriteFreezeTenant((s) => setupClient.query(s), TENANT_ATS);
      await publishLifecyclePackage(url, TENANT_ATS);
      await ensureWriteFreezeTenant((s) => setupClient.query(s), TENANT_NOT_ATS);

      // Entitle TENANT_ATS to `ats` so JwtAuthGuard → EntitlementGuard
      // permits the pipeline routes for this tenant.
      await setupClient.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
         VALUES ($1::uuid, 'ats')
         ON CONFLICT (tenant_id, capability) DO NOTHING`,
        [TENANT_ATS],
      );

      // Seed a Requisition row so the placed-transition test has a
      // concrete openings_available to prove is UNTOUCHED pre/post (the
      // T4-B2 writer removal — a `placed` transition no longer mutates
      // requisition capacity). The over-capacity FULL/ROLLBACK fixtures
      // were retired with the two deleted §5 over-capacity tests.
      await seedRequisitionWithOpenings(REQUISITION_ID, 3);

      // Requisition-expander enrichment fixtures (talent records + consent +
      // pipelines). Seeded once; the E-section reads them through GET.
      await seedEnrichmentFixtures();

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
      enrichJwt_WithTalent = await signJwt(privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: ENRICH_SCOPES_WITH_TALENT,
      });
      enrichJwt_NoTalent = await signJwt(privateKey, {
        sub: RECRUITER,
        tenant_id: TENANT_ATS,
        site_id: SITE_A,
        scopes: ENRICH_SCOPES_NO_TALENT,
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

    it('Placed transition (T4-B2): atomic 4-write — status + history + activity + metering; requisition.openings_available UNTOUCHED and delete does NOT restore', async () => {
      // T4-B2 §7 retires the PR-A5b-1 capacity coupling: the placed
      // transition is once again a FOUR-write tx (status + history +
      // activity + metering) and does NOT mutate requisition capacity.
      // Capacity availability is now DERIVED (openings - active
      // ContractAssignment count); over-capacity is representable and is
      // never a pipeline-time refusal. Here we prove the writer removal
      // directly: openings_available is UNCHANGED by the placed
      // transition AND by the subsequent delete (no restore).
      const openingsBefore = await readOpeningsAvailable(REQUISITION_ID);

      const created = await createPipeline(recruiterJwt_Ats_SiteA);

      // Walk the legal forward chain to offered, then to placed.
      await walkToOffered(recruiterJwt_Ats_SiteA, created.id);

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

      // 4-write atomicity confirmed for the placed transition.
      expect(await readStatus(created.id)).toBe('placed');
      expect(await countHistoryRows(created.id)).toBe(historyBeforePlaced + 1);
      expect(await countActivityRows(created.id)).toBe(activityBeforePlaced + 1);
      expect(await countUsageEvents()).toBe(usageBeforePlaced + 1);

      // T4-B2: openings_available is UNTOUCHED — the `placed`-edge
      // decrement writer was DELETED. (The stored column still exists in
      // this container because the DROP migration is intentionally not
      // applied here; it now reads exactly its seeded value.)
      const openingsAfterPlace = await readOpeningsAvailable(REQUISITION_ID);
      expect(openingsAfterPlace).toBe(openingsBefore);

      // T4-B2: delete of a placed pipeline does NOT restore any slot —
      // the delete-restore (+1) writer was DELETED. openings_available
      // stays exactly where it was.
      await fetch(
        `http://127.0.0.1:${port}/v1/pipelines/${created.id}?site_id=${SITE_A}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tenantAdminJwt_Ats_SiteA}` },
        },
      );
      const openingsAfterDelete = await readOpeningsAvailable(REQUISITION_ID);
      expect(openingsAfterDelete).toBe(openingsBefore);

      // The other Core boundaries still hold: submittal."TalentSubmittal
      // Record" table is not even loaded into this test container — any
      // attempted write would have thrown a relation-does-not-exist
      // long before this point.
      const submittalProbe = await setupClient
        .query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'submittal' AND table_name = 'TalentSubmittalRecord'
           ) AS exists`,
        )
        .catch(() => null);
      expect(submittalProbe?.rows[0]?.exists ?? false).toBe(false);
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

    // -------------------------------------------------------------------------
    // D) NO-Core-touch structural boundary.
    //    T4-B2 §7 RETIRED the PR-A5b-1 openings_available decrement +
    //    over-capacity 409 + delete-restore proofs (those two tests were
    //    deleted; the capacity coupling is gone and over-capacity is now
    //    representable). Only the no-Core-touch boundary survives here.
    // -------------------------------------------------------------------------

    it('NO Core touch boundary: pipeline placement touches ONLY pipeline / requisition / activity / metering — talent.* / examination.* / submittal.* / job_domain.* schemas remain absent', async () => {
      // The strongest possible boundary assertion: those four Core
      // schemas were never loaded into this test container, so any
      // write into any of them would have thrown a relation-does-not-
      // exist long before this point. We assert their absence
      // structurally via information_schema.
      const probe = await setupClient.query<{ schema_name: string }>(
        `SELECT schema_name
           FROM information_schema.schemata
          WHERE schema_name IN
            ('talent', 'examination', 'submittal', 'job_domain')
          ORDER BY schema_name`,
      );
      // These schemas are never loaded and the pipeline flow never
      // reaches for them. The assertion: NONE of the four exist in this DB.
      expect(probe.rows.map((r) => r.schema_name)).toEqual([]);

      // Sanity: the schemas the pipeline flow DOES touch are present —
      // pipeline, requisition, activity, metering.
      const present = await setupClient.query<{ schema_name: string }>(
        `SELECT schema_name
           FROM information_schema.schemata
          WHERE schema_name IN
            ('pipeline', 'requisition', 'activity', 'metering')
          ORDER BY schema_name`,
      );
      expect(present.rows.map((r) => r.schema_name)).toEqual([
        'activity',
        'metering',
        'pipeline',
        'requisition',
      ]);
    });

    // -------------------------------------------------------------------------
    // E) Requisition-expander talent enrichment on GET /v1/pipelines
    //    (LOCKED Aramo-Requisition-Expander-Talent-Rate-Columns v1.0).
    //    R-LAYERING proven end-to-end through the REAL enrichment interceptor:
    //      1. authz (talent:read) gates field EXISTENCE;
    //      2. consent (contacting) gates CONTACT-CHANNEL (email/phone) ONLY —
    //         never location / work_auth / desired_rate;
    //      3. cross-tenant contact fields never leak (tenant-scoped read).
    //    The composer lives in apps/api (the only layer that may read both
    //    talent-record and consent); libs/pipeline stays single-schema.
    // -------------------------------------------------------------------------

    it('E1 — talent:read + contacting grant: all five enrichment fields present with real values', async () => {
      const items = await listPipelinesForTalent(
        enrichJwt_WithTalent,
        ENRICH_TALENT_CONTACTABLE,
      );
      const row = items.find(
        (i) => i.talent_record_id === ENRICH_TALENT_CONTACTABLE,
      );
      expect(row, 'contactable pipeline row present in list').toBeDefined();
      // authz present + consent contactable ⇒ every field disclosed.
      expect(row!.email).toBe('dana.rivera@example.com');
      expect(row!.phone).toBe('+1-512-555-0101');
      expect(row!.location).toBe('Austin, TX');
      expect(row!.work_auth).toBe('us_citizen');
      expect(row!.desired_rate).toBe('$85/hr');
    });

    it('E2 — talent:read + do_not_contact: email/phone SUPPRESSED, location/work_auth/desired_rate REMAIN', async () => {
      const items = await listPipelinesForTalent(
        enrichJwt_WithTalent,
        ENRICH_TALENT_DNC,
      );
      const row = items.find((i) => i.talent_record_id === ENRICH_TALENT_DNC);
      expect(row, 'do_not_contact pipeline row present').toBeDefined();
      // Gate 2 — default-deny (no contacting grant) suppresses the two
      // contact CHANNELS only.
      expect(row!.email).toBeNull();
      expect(row!.phone).toBeNull();
      // Non-contact attributes are NEVER consent-gated — they survive.
      expect(row!.location).toBe('Seattle, WA');
      expect(row!.work_auth).toBe('green_card');
      expect(row!.desired_rate).toBe('$92/hr');
    });

    it('E3 — NO talent:read: existence gate nulls ALL five fields even for a contactable talent', async () => {
      const items = await listPipelinesForTalent(
        enrichJwt_NoTalent,
        ENRICH_TALENT_CONTACTABLE,
      );
      const row = items.find(
        (i) => i.talent_record_id === ENRICH_TALENT_CONTACTABLE,
      );
      expect(row, 'contactable pipeline row present').toBeDefined();
      // Gate 1 — authz gates EXISTENCE: same row that E1 fully enriched now
      // carries five nulls purely because talent:read is absent.
      expect(row!.email).toBeNull();
      expect(row!.phone).toBeNull();
      expect(row!.location).toBeNull();
      expect(row!.work_auth).toBeNull();
      expect(row!.desired_rate).toBeNull();
    });

    it('E4 — talent:read: cross-tenant TalentRecord contact fields NEVER leak (tenant isolation)', async () => {
      const items = await listPipelinesForTalent(
        enrichJwt_WithTalent,
        ENRICH_TALENT_CROSS_TENANT,
      );
      const row = items.find(
        (i) => i.talent_record_id === ENRICH_TALENT_CROSS_TENANT,
      );
      // The pipeline row is in TENANT_ATS; the referenced TalentRecord lives in
      // TENANT_NOT_ATS. findContactByIds filters by tenant_id ⇒ no row found ⇒
      // no enrichment. The other tenant's contact fields are never surfaced.
      expect(row, 'cross-tenant pipeline row present in ATS list').toBeDefined();
      expect(row!.email).toBeNull();
      expect(row!.phone).toBeNull();
      expect(row!.location).toBeNull();
      expect(row!.work_auth).toBeNull();
      expect(row!.desired_rate).toBeNull();
    });
  },
);
