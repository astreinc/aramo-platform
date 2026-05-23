import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
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

// M4 PR-3 §4.7 — Companion negative-shape integration test for the new
// POST /v1/submittals endpoint. F23 standing pattern: a Vitest end-to-end
// test that boots AppModule + posts a real create request + walks the
// response body recursively, asserting that no forbidden Match-Class
// vocabulary leaks into the submittal-create response.
//
// Match-Class forbidden keys (API Contracts v1.0 Phase 6 / R10):
//   tier, rank, rank_ordinal, score, internal_reasoning,
//   why_matched_sentence, strengths, gaps, risk_flags, recruiter_notes,
//   override_id, action_queue_item_id, internal_engagement_state
//
// Gated on ARAMO_RUN_INTEGRATION=1.

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
const TALENT_EVIDENCE_INIT_MIGRATION = resolve(
  ROOT,
  'libs/talent-evidence/prisma/migrations/20260519170000_init_talent_evidence_model/migration.sql',
);
const EVIDENCE_INIT_MIGRATION = resolve(
  ROOT,
  'libs/evidence/prisma/migrations/20260522090000_init_evidence_model/migration.sql',
);
const SUBMITTAL_INIT_MIGRATION = resolve(
  ROOT,
  'libs/submittal/prisma/migrations/20260523120000_init_submittal_model/migration.sql',
);

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-submittal-neg-shape';
const ALG = 'RS256';

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const JOB_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const RECRUITER_ID = '00000000-0000-7000-8000-000000000bb1';
const GOLDEN_ID = '44441111-4444-7444-8444-444444444444';
const EXAM_ID = '11110000-0000-7000-8000-0000000e0001';

const FORBIDDEN_MATCH_CLASS_KEYS: ReadonlyArray<string> = [
  'tier',
  'rank',
  'rank_ordinal',
  'score',
  'internal_reasoning',
  'why_matched_sentence',
  'strengths',
  'gaps',
  'risk_flags',
  'recruiter_notes',
  'override_id',
  'action_queue_item_id',
  'internal_engagement_state',
];

function walkForForbiddenKeys(
  node: unknown,
  path: string,
  hits: Array<{ path: string; key: string }>,
): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      walkForForbiddenKeys(node[i], `${path}[${i}]`, hits);
    }
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (FORBIDDEN_MATCH_CLASS_KEYS.includes(k)) {
      hits.push({ path: `${path}.${k}`, key: k });
    }
    walkForForbiddenKeys(v, `${path}.${k}`, hits);
  }
}

const VALID_BODY = {
  talent_id: TALENT_ID,
  job_id: JOB_ID,
  examination_id: EXAM_ID,
  talent_identity: {
    full_name: 'Sample Talent',
    preferred_name: 'Sam',
    location: 'Remote (US)',
  },
  contact_summary: {
    contact_available: true,
    channels_verified: ['email'],
  },
  capability_summary_overrides: {
    key_work_history: [
      {
        employer_name: 'Acme Corp',
        role_title: 'Senior Engineer',
        start_date: '2021-01-01',
      },
    ],
    certifications: ['AWS Solutions Architect'],
  },
  recruiter_contribution: {
    screening_notes: 'Spoke 2026-05-23.',
    conversation_summary: {
      recruiter_summary: 'Discussed role, fit, and timing.',
    },
    talent_confirmed: {
      spoken_to_recruiter: true,
    },
  },
};

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'POST /v1/submittals — negative-shape (no Match-Class vocabulary leak)',
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
      for (const migrationPath of [
        CONSENT_MIGRATION,
        INGESTION_INIT_MIGRATION,
        INGESTION_SURFACE_MIGRATION,
        EXAMINATION_INIT_MIGRATION,
        EXAMINATION_LIVE_LIST_MIGRATION,
        JOB_DOMAIN_INIT_MIGRATION,
        TALENT_EVIDENCE_INIT_MIGRATION,
        EVIDENCE_INIT_MIGRATION,
        SUBMITTAL_INIT_MIGRATION,
      ]) {
        await setup.query(readFileSync(migrationPath, 'utf8'));
      }

      // Seed an active requisition + an Entrustable examination so the
      // builder happy-path completes.
      await setup.query(
        `INSERT INTO job_domain."Requisition" (id, tenant_id, job_id, recruiter_id, state)
         VALUES ($1, $2, $3, $4, 'active'::job_domain."RequisitionState")`,
        ['22221111-0000-7000-8000-0000000000aa', TENANT_ID, JOB_ID, RECRUITER_ID],
      );
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
          EXAM_ID,
          TENANT_ID,
          TALENT_ID,
          JOB_ID,
          GOLDEN_ID,
          'ENTRUSTABLE',
          1,
          'matched on critical skills',
          'baseline match',
          JSON.stringify([]),
          JSON.stringify({ matched_count: 5, missing_count: 0, per_skill: [] }),
          JSON.stringify({ years: 7, summary: 'Strong overlap' }),
          JSON.stringify({}),
          JSON.stringify(['typescript-expertise']),
          JSON.stringify([]),
          JSON.stringify([]),
          JSON.stringify({
            evidence_strength: { level: 'high', basis: 'ingested-evidence' },
            data_completeness: { level: 'high', basis: 'profile-complete' },
            constraint_confidence: { level: 'high', basis: 'verified' },
          }),
          JSON.stringify({ profile_age_days: 14 }),
          JSON.stringify(null),
          'v1',
          'v1',
          'v1',
          '2026-05-22T09:00:00.000Z',
        ],
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
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }),
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

    it('201 response contains no Match-Class vocabulary keys anywhere', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/submittals`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${recruiterJwt}`,
          'Idempotency-Key': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(VALID_BODY),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as unknown;

      const hits: Array<{ path: string; key: string }> = [];
      walkForForbiddenKeys(body, '$', hits);
      expect(
        hits,
        `Match-Class vocabulary leaked into POST /v1/submittals response: ${hits
          .map((h) => `${h.path}`)
          .join(', ')}`,
      ).toEqual([]);
    });
  },
);
