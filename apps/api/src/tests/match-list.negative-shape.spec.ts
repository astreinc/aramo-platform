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

// M3 PR-8 §4.6 — Companion Vitest negative-shape integration test (the
// "not Full" half of Ruling 3 / F23). End-to-end:
//
//   1. Boot apps/api AppModule against a Postgres 17 testcontainer with
//      the consent + ingestion + examination + job-domain migrations
//      applied (same set as the Pact provider verifier's apps/api branch).
//   2. Sign a real recruiter JWT, set AUTH_PUBLIC_KEY/AUTH_AUDIENCE so
//      JwtAuthGuard accepts it.
//   3. Seed an active Requisition + three ranked Summary examinations
//      via raw SQL (the verifier harness pattern; bypasses
//      ExaminationRepository.createSnapshot to keep the migration
//      bootstrap small).
//   4. Hit GET /v1/jobs/{job_id}/matches with the recruiter JWT.
//   5. Assert each TalentJobExaminationFull-specific field (directive
//      §4.6: 13 fields) is absent from each item in response.data.
//
// This is the F23 standing pattern's "negative" half — Pact's V4
// matchers express positive expectations only, so the Full-specific
// absence assertion lives here rather than in the Pact consumer test.
//
// Gated on ARAMO_RUN_INTEGRATION=1. The spec is hosted in apps/api/src/
// tests/ rather than libs/examination/src/tests/ (the directive §4.6
// path) because the static import of @aramo/api (AppModule) from a
// libs/examination test file would create an Nx project-graph cycle
// (libs/examination → @aramo/api → MatchingModule → @aramo/examination).
// apps/api owns AppModule; AppModule-end-to-end assertions live here.
// The directive's intent (Summary-only assertion on the match-list HTTP
// response, plus apps/api becoming the 6th integration root) is
// preserved by this placement. Deviation noted in the Gate 5 report.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');
const CONSENT_MIGRATION = resolve(
  ROOT,
  'libs/consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql',
);
const INGESTION_INIT_MIGRATION = resolve(
  ROOT,
  'libs/ingestion/prisma/migrations/20260516130715_init_ingestion_model/migration.sql',
);
const INGESTION_SURFACE_MIGRATION = resolve(
  ROOT,
  'libs/ingestion/prisma/migrations/20260516183528_add_skill_surface_forms/migration.sql',
);
const EXAMINATION_INIT_MIGRATION = resolve(
  ROOT,
  'libs/examination/prisma/migrations/20260517200000_init_examination_model/migration.sql',
);
const EXAMINATION_LIVE_LIST_MIGRATION = resolve(
  ROOT,
  'libs/examination/prisma/migrations/20260521120000_add_live_list_index/migration.sql',
);
const JOB_DOMAIN_INIT_MIGRATION = resolve(
  ROOT,
  'libs/job-domain/prisma/migrations/20260519100000_init_job_domain_model/migration.sql',
);

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-negative-shape-audience';
const ALG = 'RS256';

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const JOB_ID = '22222222-2222-7222-8222-222222222222';
const REQ_ID = '33333333-3333-7333-8333-333333333333';
const RECRUITER_ID = '00000000-0000-0000-0000-0000000000bb';
const GOLDEN_ID = '44444444-4444-7444-8444-444444444444';
const TALENT_1 = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const TALENT_2 = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const TALENT_3 = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const EXAM_1 = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const EXAM_2 = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
const EXAM_3 = 'ffffffff-ffff-7fff-8fff-ffffffffffff';

const FULL_SPECIFIC_FIELDS = [
  'expanded_reasoning',
  'evidence_references',
  'risk_flags',
  'confidence_indicators',
  'delta_to_entrustable',
  'skill_match',
  'experience_match',
  'constraint_checks',
  'strengths',
  'gaps',
  'lifecycle_state',
  'archived_at',
  'superseded_by_examination_id',
] as const;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'GET /v1/jobs/{job_id}/matches — negative-shape (Summary-only contract end-to-end)',
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

      // Apply the same migration set the apps/api pact verifier uses.
      // node-postgres simple-query protocol handles dollar-quoted PL/pgSQL
      // bodies (the examination immutability trigger) verbatim.
      const setup = new Client({ connectionString: url });
      await setup.connect();
      for (const migrationPath of [
        CONSENT_MIGRATION,
        INGESTION_INIT_MIGRATION,
        INGESTION_SURFACE_MIGRATION,
        EXAMINATION_INIT_MIGRATION,
        EXAMINATION_LIVE_LIST_MIGRATION,
        JOB_DOMAIN_INIT_MIGRATION,
      ]) {
        await setup.query(readFileSync(migrationPath, 'utf8'));
      }

      // Seed an active Requisition + three ranked Summary examinations.
      await setup.query(
        `INSERT INTO job_domain."Requisition" (id, tenant_id, job_id, recruiter_id, state)
         VALUES ($1, $2, $3, $4, 'active'::job_domain."RequisitionState")`,
        [REQ_ID, TENANT_ID, JOB_ID, RECRUITER_ID],
      );

      const tiers = ['ENTRUSTABLE', 'WORTH_CONSIDERING', 'STRETCH'] as const;
      const exams = [
        { id: EXAM_1, talent: TALENT_1 },
        { id: EXAM_2, talent: TALENT_2 },
        { id: EXAM_3, talent: TALENT_3 },
      ];
      for (let i = 0; i < exams.length; i++) {
        const examRow = exams[i];
        const tier = tiers[i];
        if (examRow === undefined || tier === undefined) continue;
        const { id, talent } = examRow;
        await setup.query(
          `INSERT INTO examination."TalentJobExamination"
             (id, tenant_id, talent_id, job_id, golden_profile_id, trigger,
              tier, rank_ordinal, why_matched_sentence, match_summary,
              expanded_reasoning, skill_match, experience_match,
              constraint_checks, strengths, gaps, risk_flags,
              confidence_indicators, freshness_indicator, delta_to_entrustable,
              examination_version, model_version, taxonomy_version,
              computed_at, lifecycle_state)
           VALUES ($1,$2,$3,$4,$5,'initial_match'::examination."ExaminationTrigger",
                   $6::examination."ExaminationTier",$7,$8,$9,
                   $10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,
                   $15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,
                   $20,$21,$22,$23,'active'::examination."ExaminationLifecycleState")`,
          [
            id,
            TENANT_ID,
            talent,
            JOB_ID,
            GOLDEN_ID,
            tier,
            i + 1,
            'matched on skills X and Y',
            'baseline match',
            JSON.stringify([]),
            JSON.stringify({
              matched_count: 1,
              missing_count: 0,
              per_skill: [
                { name: 'TypeScript', evidence_count: 1, has_ingested_evidence: true },
              ],
            }),
            JSON.stringify({}),
            JSON.stringify({}),
            JSON.stringify(['baseline']),
            JSON.stringify([]),
            JSON.stringify([]),
            JSON.stringify({
              evidence_strength: { level: 'medium', basis: 'evidence_count' },
              data_completeness: { level: 'high', basis: 'fields_present' },
              constraint_confidence: { level: 'medium', basis: 'rate_overlap' },
            }),
            JSON.stringify({ profile_age_days: 14 }),
            JSON.stringify(null),
            'v1',
            'v1',
            'v1',
            '2026-05-01T12:00:00.000Z',
          ],
        );
      }
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

    it('returns 200 and emits ZERO Full-specific fields in any data[] item', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/jobs/${JOB_ID}/matches`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${recruiterJwt}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<Record<string, unknown>>;
        pagination: { page_size: number; has_more: boolean };
      };

      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(3);
      expect(body.pagination.page_size).toBe(3);

      // Per-field absence — directive §4.6: each Full-specific field
      // checked individually with a failure message identifying which
      // leaked.
      for (let i = 0; i < body.data.length; i++) {
        const item = body.data[i];
        if (item === undefined) continue;
        for (const field of FULL_SPECIFIC_FIELDS) {
          expect(
            item,
            `Full-specific field "${field}" leaked into data[${i}] of the Summary response`,
          ).not.toHaveProperty(field);
        }
      }
    });

    it('returns 200 with the locked Summary-required key set and no extras', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/jobs/${JOB_ID}/matches`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${recruiterJwt}` },
      });
      const body = (await res.json()) as { data: Array<Record<string, unknown>> };
      const EXPECTED_KEYS = new Set([
        'examination_id',
        'talent_id',
        'job_id',
        'tier',
        'rank_ordinal',
        'why_matched_sentence',
        'top_skills',
        'confidence_summary',
        'freshness_indicator',
        'computed_at',
      ]);
      for (const item of body.data) {
        const keys = new Set(Object.keys(item));
        expect(keys).toEqual(EXPECTED_KEYS);
      }
    });
  },
);
