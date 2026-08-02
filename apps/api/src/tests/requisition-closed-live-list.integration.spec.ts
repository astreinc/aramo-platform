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

// T1-a — job_domain.Requisition retirement (LIVE DEFECT proof).
//
// The defect this test exists to expose: `job_domain.Requisition.state` is
// written once as 'active' and has NO updater. A requisition CLOSED in the ATS
// (`requisition.Requisition.status = 'closed'`) still reads `active` through the
// job_domain mirror — so the match-list surfaces a closed requisition's matches
// as if it were open.
//
// The seeded state mirrors production AFTER a close: the ATS requisition is
// `closed`, but the job_domain mirror is still `active` (it was minted active at
// confirmProfile and never touched again). GET /v1/jobs/R/matches MUST return an
// empty list — a closed requisition has no live matches.
//
//   - Against CURRENT code (match-list resolves through job_domain.Requisition):
//     the stale-active mirror is found, the examination is returned → this test
//     FAILS. That failure IS the defect.
//   - After T1-a (match-list resolves the ACTIVE requisition through the
//     RequisitionStateReader port, backed by requisition.Requisition.status):
//     the closed requisition is not active → empty list → this test PASSES.
//
// Gated on ARAMO_RUN_INTEGRATION=1. Hosted in apps/api/src/tests/ (AppModule
// owner) for the same Nx-cycle reason as examine-live-list.integration.spec.ts.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');

// Migration set — per-schema chronological order (cross-schema is UUID-only,
// no FK, so schema interleaving is free). Mirrors examine-live-list's set.
const MIGRATIONS = [
  // requisition (ATS)
  'libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql',
  'libs/requisition/prisma/migrations/20260603140100_add_import_batch_id_to_requisition/migration.sql',
  'libs/requisition/prisma/migrations/20260605123400_add_compensation_fields_to_requisition/migration.sql',
  'libs/requisition/prisma/migrations/20260609120000_search_pr1_pg_trgm_gin/migration.sql',
  'libs/requisition/prisma/migrations/20260611220000_job_module_requisition_fields/migration.sql',
  'libs/requisition/prisma/migrations/20260612120000_drop_legacy_requisition_comp/migration.sql',
  'libs/requisition/prisma/migrations/20260618120000_add_rate_type_subk_runmatch/migration.sql',
  'libs/requisition/prisma/migrations/20260721000000_add_publish_surface/migration.sql',
  // Track 1 T1-b — additive `version` optimistic-concurrency column; regenerated
  // client SELECTs it on every requisition read/write (missing → 500).
  'libs/requisition/prisma/migrations/20260801120000_add_version_to_requisition/migration.sql',
  // PR-17 — additive onsite_days_per_week column (missing -> 500 on requisition reads/writes).
  'libs/requisition/prisma/migrations/20260802140000_add_onsite_days_to_requisition/migration.sql',
  // PR-14 — additive user_requisition_state table (missing -> 500 on enriched requisition list/get).
  'libs/requisition/prisma/migrations/20260802160000_add_user_requisition_state/migration.sql',
  // job-domain
  'libs/job-domain/prisma/migrations/20260519100000_init_job_domain_model/migration.sql',
  // T1-a — drop the retired job_domain.Requisition table + enum so this proof
  // runs against the true post-retirement schema (Job + GoldenProfile remain).
  'libs/job-domain/prisma/migrations/20260801130000_drop_job_domain_requisition/migration.sql',
  // talent-record
  'libs/talent-record/prisma/migrations/20260602120000_init_talent_record_model/migration.sql',
  'libs/talent-record/prisma/migrations/20260603020000_add_core_talent_link_to_talent_record/migration.sql',
  'libs/talent-record/prisma/migrations/20260603140100_add_import_batch_id_to_talent_record/migration.sql',
  'libs/talent-record/prisma/migrations/20260609120000_search_pr1_pg_trgm_gin/migration.sql',
  'libs/talent-record/prisma/migrations/20260609130000_search_pr2_resume_text/migration.sql',
  'libs/talent-record/prisma/migrations/20260615000000_talent_stated_fields/migration.sql',
  'libs/talent-record/prisma/migrations/20260615120000_talent_search_indexes/migration.sql',
  'libs/talent-record/prisma/migrations/20260630140000_overlay_fold_cluster_id/migration.sql',
  'libs/talent-record/prisma/migrations/20260701120000_drop_core_talent_id/migration.sql',
  'libs/talent-record/prisma/migrations/20260702120000_add_work_authorization_to_talent_record/migration.sql',
  'libs/talent-record/prisma/migrations/20260706210000_tr2a_b3a_talent_record_supersession/migration.sql',
  // talent-evidence
  'libs/talent-evidence/prisma/migrations/20260519170000_init_talent_evidence_model/migration.sql',
  'libs/talent-evidence/prisma/migrations/20260714120000_tr7_b1_education_certification/migration.sql',
  // talent-trust
  'libs/talent-trust/prisma/migrations/20260628000000_init_talent_trust/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703120000_tr2a1_subject_anchor/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703130000_tr2a2_match_advisory/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703140000_tr2a3_advisory_resolution/migration.sql',
  'libs/talent-trust/prisma/migrations/20260705120000_add_reconcile_watermark_to_resolution_subject/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706120000_ats_ref_partial_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706160000_sourcing_pool_keyset_index/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706170000_tr2a_b1_subject_anchor_source_class/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706180000_tr2a_b1_subject_anchor_source_class_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706200000_tr2a_b2_advisory_reopen_provenance/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706230000_tr2a_b3b_subject_merge_operation/migration.sql',
  'libs/talent-trust/prisma/migrations/20260707120000_tr6_b1_last_matched_at/migration.sql',
  'libs/talent-trust/prisma/migrations/20260707130000_tr6_b1_merge_operation_kind/migration.sql',
  'libs/talent-trust/prisma/migrations/20260708120000_tr3_b1_verification_request/migration.sql',
  'libs/talent-trust/prisma/migrations/20260709120000_tr4_b1_evidence_link_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260710120000_tr4_b3_last_consistency_at/migration.sql',
  'libs/talent-trust/prisma/migrations/20260711120000_tr5_b2_thinness_flags/migration.sql',
  'libs/talent-trust/prisma/migrations/20260712120000_tr8_b1_verified_control_stale/migration.sql',
  'libs/talent-trust/prisma/migrations/20260713120000_tr12_b1_verification_proposal/migration.sql',
  // examination
  'libs/examination/prisma/migrations/20260517200000_init_examination_model/migration.sql',
  'libs/examination/prisma/migrations/20260521120000_add_live_list_index/migration.sql',
].map((p) => resolve(ROOT, p));

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-requisition-closed-live-list-audience';
const ALG = 'RS256';

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
// R — the shared UUID: ATS requisition id = job_domain Job.id = GoldenProfile.job_id
// = examination.job_id.
const R = '22222222-2222-7222-8222-222222222222';
const GP_ID = '44444444-4444-7444-8444-444444444444';
const RECRUITER_ID = '00000000-0000-0000-0000-0000000000bb';
const COMPANY_ID = '55555555-5555-7555-8555-555555555555';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const SKILL_ID = '99999999-9999-7999-8999-999999999999';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T1-a live defect — a requisition CLOSED in the ATS is not active to the match-list',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let recruiterJwt: string;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const setup = new Client({ connectionString: url });
      await setup.connect();
      for (const migrationPath of MIGRATIONS) {
        await setup.query(readFileSync(migrationPath, 'utf8'));
      }

      await ensureWriteFreezeTenant((s) => setup.query(s), TENANT_ID);

      // job_domain.Job(id = R)
      await setup.query(
        `INSERT INTO job_domain."Job" (id, tenant_id) VALUES ($1, $2)`,
        [R, TENANT_ID],
      );
      // job_domain.GoldenProfile(id = GP, job_id = R)
      await setup.query(
        `INSERT INTO job_domain."GoldenProfile"
           (id, tenant_id, job_id, skills, experience, constraints, critical_skills)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)`,
        [
          GP_ID,
          TENANT_ID,
          R,
          JSON.stringify({
            role_family: 'backend_engineer',
            seniority_level: 'senior',
            jd_text: 'Senior backend engineer.',
            generated_by: 'manual',
            required_skills: [{ name: 'TypeScript' }],
            preferred_skills: [],
            critical_skills: [{ name: 'TypeScript' }],
          }),
          JSON.stringify({ industries: [] }),
          JSON.stringify({}),
          ['TypeScript'],
        ],
      );
      // requisition.Requisition (ATS) — id = R, golden_profile_id = GP, and
      // CLOSED. This is the authoritative lifecycle state; the match-list must
      // honour it.
      await setup.query(
        `INSERT INTO requisition."Requisition"
           (id, tenant_id, title, company_id, golden_profile_id, status)
         VALUES ($1, $2, $3, $4, $5, 'closed'::requisition."RequisitionStatus")`,
        [R, TENANT_ID, 'Senior Backend Engineer', COMPANY_ID, GP_ID],
      );
      // NOTE: pre-T1-a a stale-active job_domain.Requisition mirror was seeded
      // here to reproduce the defect (RED). Post-T1-a the mirror is retired and
      // the match-list resolves the ATS requisition's status via the port, so
      // the closed requisition below is correctly not-active with no mirror.
      // talent_record.TalentRecord — declared work_authorization + contact.
      await setup.query(
        `INSERT INTO talent_record."TalentRecord"
           (id, tenant_id, first_name, last_name, city, state, desired_pay,
            work_authorization, key_skills, email1)
         VALUES ($1, $2, 'Ada', 'Lovelace', 'Austin', 'TX', '$70/hr',
                 'US_CITIZEN', 'typescript, postgresql', 'ada@example.com')`,
        [TALENT_ID, TENANT_ID],
      );
      // Pre-seed one declared TalentSkillEvidence so examine's lazy extraction
      // is SKIPPED (exists-check > 0) — keeps the boot LLM-free.
      await setup.query(
        `INSERT INTO talent_evidence."TalentSkillEvidence"
           (id, talent_id, tenant_id, skill_id, surface_form, source, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'TypeScript',
                 'declared'::talent_evidence."TalentSkillEvidenceSource", CURRENT_TIMESTAMP)`,
        [TALENT_ID, TENANT_ID, SKILL_ID],
      );
      await setup.end();

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

      recruiterJwt = await new SignJWT({
        sub: RECRUITER_ID,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: TENANT_ID,
        scopes: [],
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);

      module = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      await app.init();
      const server = await app.listen(0);
      const address = server.address() as AddressInfo;
      port = address.port;
    }, 180_000);

    afterAll(async () => {
      await app?.close();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    it('examine still mints an examination for the (talent, R) pair (status-agnostic)', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/examinations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ talent_id: TALENT_ID, requisition_id: R }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { job_id: string };
      expect(body.job_id).toBe(R);
    });

    it('GET /v1/jobs/R/matches returns EMPTY — a closed requisition has no live matches', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/jobs/${R}/matches`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${recruiterJwt}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<Record<string, unknown>>;
      };
      expect(Array.isArray(body.data)).toBe(true);
      // The defect: a requisition closed in the ATS must NOT surface its
      // examinations. Against current code the stale-active job_domain mirror
      // makes this list non-empty — that failure is the defect this PR fixes.
      expect(body.data.length).toBe(0);
    });
  },
);
