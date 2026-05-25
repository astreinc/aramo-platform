import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { AramoError, makeMockLogger } from '@aramo/common';
import {
  EngagementEventRepository,
  PrismaService as EngagementPrismaService,
} from '@aramo/engagement';
import {
  ExaminationRepository,
  PrismaService as ExaminationPrismaService,
} from '@aramo/examination';
import {
  TalentEvidenceRepository,
  PrismaService as TalentEvidencePrismaService,
} from '@aramo/talent-evidence';

import type { BuildPackageInput } from '../lib/dto/talent-job-evidence-package.view.js';
import { EvidenceRepository } from '../lib/evidence.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// M5 PR-2 §4.11 — cross-schema engagement_event_refs validator integration.
//
// Brings up a Postgres 17 testcontainer, applies the 5 migrations needed
// for the full buildPackage flow under the validator scope:
//   - evidence/init (TalentJobEvidencePackage + immutability trigger)
//   - examination/init + add_live_list_index (TalentJobExamination)
//   - engagement/init (TalentJobEngagement)
//   - engagement/add_engagement_event_log (TalentEngagementEvent + FK + trigger)
//
// Seeds:
//   - 1 Entrustable TalentJobExamination in TENANT_A (so buildPackage Step
//     2 finds it and Step 3 doesn't refuse with SUBMITTAL_STRETCH_BLOCKED).
//   - 1 TalentJobEngagement in TENANT_A + 1 in TENANT_B (FK parents).
//   - 2 TalentEngagementEvents in TENANT_A (the valid refs).
//   - 1 TalentEngagementEvent in TENANT_B (the cross-tenant ref for the
//     ENGAGEMENT_EVENT_REF_NOT_FOUND assertion).
//
// 5 scenarios per directive §4.8 / Ruling 7:
//   1. engagement_event_refs: [] -> passes.
//   2. engagement_event_refs: null (input shape) -> passes.
//   3. engagement_event_refs: [validUuidA, validUuidB] same-tenant -> passes;
//      row persists with both UUIDs in the JSONB column.
//   4. engagement_event_refs: [validUuid, invalidUuid] -> throws
//      ENGAGEMENT_EVENT_REF_NOT_FOUND with invalidUuid detail.
//   5. engagement_event_refs: [otherTenantUuid] -> throws
//      ENGAGEMENT_EVENT_REF_NOT_FOUND (findByTenantAndId is tenant-scoped
//      per Architecture §7.2; cross-tenant rows surface as null).

const EVIDENCE_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260522090000_init_evidence_model/migration.sql',
);
const EXAMINATION_INIT_MIGRATION_PATH = resolve(
  __dirname,
  '../../../examination/prisma/migrations/20260517200000_init_examination_model/migration.sql',
);
const EXAMINATION_LIVE_LIST_MIGRATION_PATH = resolve(
  __dirname,
  '../../../examination/prisma/migrations/20260521120000_add_live_list_index/migration.sql',
);
const ENGAGEMENT_INIT_MIGRATION_PATH = resolve(
  __dirname,
  '../../../engagement/prisma/migrations/20260525120000_init_engagement_model/migration.sql',
);
const ENGAGEMENT_EVENT_LOG_MIGRATION_PATH = resolve(
  __dirname,
  '../../../engagement/prisma/migrations/20260525150000_add_engagement_event_log/migration.sql',
);

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const TALENT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const JOB_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const GOLDEN_PROFILE_ID = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const EXAMINATION_ID = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';

const ENGAGEMENT_TENANT_A = '33333333-3333-7333-8333-333333333333';
const ENGAGEMENT_TENANT_B = '44444444-4444-7444-8444-444444444444';

const VALID_EVENT_A = '55555555-5555-7555-8555-000000000001';
const VALID_EVENT_B = '55555555-5555-7555-8555-000000000002';
const TENANT_B_EVENT = '66666666-6666-7666-8666-000000000001';
const NONEXISTENT_EVENT = '99999999-9999-7999-8999-999999999999';

// UUID v7-shaped IDs for the 5 build scenarios. Final group must be
// exactly 12 hex chars per evidence.repository UUID_REGEX validation.
const PACKAGE_IDS: Record<string, string> = {
  '001': '77770000-0000-7000-8000-aaaaaaaa0001',
  '002': '77770000-0000-7000-8000-aaaaaaaa0002',
  '003': '77770000-0000-7000-8000-aaaaaaaa0003',
  '004': '77770000-0000-7000-8000-aaaaaaaa0004',
  '005': '77770000-0000-7000-8000-aaaaaaaa0005',
};

function makeBuildInput(
  packageSeq: string,
  overrides: Partial<BuildPackageInput> = {},
): BuildPackageInput {
  const base: BuildPackageInput = {
    id: PACKAGE_IDS[packageSeq] as string,
    tenant_id: TENANT_A,
    talent_id: TALENT_A,
    job_id: JOB_ID,
    examination_id: EXAMINATION_ID,
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
      screening_notes: 'Spoke 2026-05-25.',
      conversation_summary: {
        recruiter_summary: 'Discussed role, fit, and timing.',
      },
      talent_confirmed: {
        spoken_to_recruiter: true,
      },
    },
  };
  return { ...base, ...overrides };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'EvidenceRepository.buildPackage — cross-schema engagement_event_refs validator (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let evidencePrisma: PrismaService;
    let examPrisma: ExaminationPrismaService;
    let talentEvidencePrisma: TalentEvidencePrismaService;
    let engagementPrisma: EngagementPrismaService;
    let repo: EvidenceRepository;
    let setupClient: PrismaService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const migrations = [
        readFileSync(EVIDENCE_MIGRATION_PATH, 'utf8'),
        readFileSync(EXAMINATION_INIT_MIGRATION_PATH, 'utf8'),
        readFileSync(EXAMINATION_LIVE_LIST_MIGRATION_PATH, 'utf8'),
        readFileSync(ENGAGEMENT_INIT_MIGRATION_PATH, 'utf8'),
        readFileSync(ENGAGEMENT_EVENT_LOG_MIGRATION_PATH, 'utf8'),
      ];

      setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const sql of migrations) {
        for (const stmt of splitDdl(sql)) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setupClient.$executeRawUnsafe(trimmed);
        }
      }

      // Per-module clients (each PrismaClient knows only about its
      // module's models; cross-schema seed/teardown via setupClient
      // raw SQL).
      evidencePrisma = new PrismaService(url);
      await evidencePrisma.$connect();
      examPrisma = new ExaminationPrismaService(url);
      await examPrisma.$connect();
      talentEvidencePrisma = new TalentEvidencePrismaService(url);
      await talentEvidencePrisma.$connect();
      engagementPrisma = new EngagementPrismaService(url);
      await engagementPrisma.$connect();

      const examRepo = new ExaminationRepository(examPrisma, undefined as never);
      const talentEvidenceRepo = new TalentEvidenceRepository(talentEvidencePrisma);
      const engagementEventRepo = new EngagementEventRepository(
        engagementPrisma,
        makeMockLogger(),
      );
      repo = new EvidenceRepository(
        evidencePrisma,
        examRepo,
        talentEvidenceRepo,
        engagementEventRepo,
        makeMockLogger(),
      );

      // Seed: Entrustable examination (TENANT_A).
      await seedExamination(setupClient, {
        id: EXAMINATION_ID,
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        job_id: JOB_ID,
      });

      // Seed: parent engagements (TENANT_A + TENANT_B).
      await seedEngagement(setupClient, {
        id: ENGAGEMENT_TENANT_A,
        tenant_id: TENANT_A,
      });
      await seedEngagement(setupClient, {
        id: ENGAGEMENT_TENANT_B,
        tenant_id: TENANT_B,
      });

      // Seed: engagement events. 2 valid TENANT_A events, 1 TENANT_B event.
      await seedEngagementEvent(setupClient, {
        id: VALID_EVENT_A,
        tenant_id: TENANT_A,
        engagement_id: ENGAGEMENT_TENANT_A,
        event_type: 'state_transition',
        event_payload: { from: 'surfaced', to: 'evaluated' },
      });
      await seedEngagementEvent(setupClient, {
        id: VALID_EVENT_B,
        tenant_id: TENANT_A,
        engagement_id: ENGAGEMENT_TENANT_A,
        event_type: 'outreach_sent',
        event_payload: { channel: 'email' },
      });
      await seedEngagementEvent(setupClient, {
        id: TENANT_B_EVENT,
        tenant_id: TENANT_B,
        engagement_id: ENGAGEMENT_TENANT_B,
        event_type: 'state_transition',
        event_payload: {},
      });
    }, 240_000);

    afterAll(async () => {
      await setupClient?.$disconnect();
      await evidencePrisma?.$disconnect();
      await examPrisma?.$disconnect();
      await talentEvidencePrisma?.$disconnect();
      await engagementPrisma?.$disconnect();
      await container?.stop();
    });

    it('scenario 1: engagement_event_refs: [] passes (empty array)', async () => {
      const view = await repo.buildPackage(
        makeBuildInput('001', { engagement_event_refs: [] }),
      );
      expect(view.id).toBe(PACKAGE_IDS['001'] as string);
      expect(view.engagement_event_refs).toEqual([]);
    });

    it('scenario 2: engagement_event_refs: null (omitted from input) passes', async () => {
      // Omit the field entirely from the input shape; the validator
      // short-circuits and Step 7 coerces to [].
      const view = await repo.buildPackage(makeBuildInput('002'));
      expect(view.id).toBe(PACKAGE_IDS['002'] as string);
      expect(view.engagement_event_refs).toEqual([]);
    });

    it('scenario 3: engagement_event_refs: [validUuidA, validUuidB] same-tenant passes', async () => {
      const view = await repo.buildPackage(
        makeBuildInput('003', {
          engagement_event_refs: [VALID_EVENT_A, VALID_EVENT_B],
        }),
      );
      expect(view.id).toBe(PACKAGE_IDS['003'] as string);
      expect(view.engagement_event_refs).toEqual([VALID_EVENT_A, VALID_EVENT_B]);

      // Confirm row persisted via direct read.
      const reread = await repo.findById({
        tenant_id: TENANT_A,
        id: PACKAGE_IDS['003'] as string,
      });
      expect(reread?.engagement_event_refs).toEqual([VALID_EVENT_A, VALID_EVENT_B]);
    });

    it('scenario 4: engagement_event_refs: [valid, invalid] throws ENGAGEMENT_EVENT_REF_NOT_FOUND', async () => {
      const promise = repo.buildPackage(
        makeBuildInput('004', {
          engagement_event_refs: [VALID_EVENT_A, NONEXISTENT_EVENT],
        }),
      );
      await expect(promise).rejects.toBeInstanceOf(AramoError);
      try {
        await promise;
      } catch (err) {
        expect(err).toBeInstanceOf(AramoError);
        const e = err as AramoError;
        expect(e.code).toBe('ENGAGEMENT_EVENT_REF_NOT_FOUND');
        expect(e.statusCode).toBe(422);
        expect(e.context.details?.['engagement_event_ref']).toBe(NONEXISTENT_EVENT);
      }
    });

    it('scenario 5: engagement_event_refs: [otherTenantUuid] throws ENGAGEMENT_EVENT_REF_NOT_FOUND', async () => {
      const promise = repo.buildPackage(
        makeBuildInput('005', {
          engagement_event_refs: [TENANT_B_EVENT],
        }),
      );
      await expect(promise).rejects.toBeInstanceOf(AramoError);
      try {
        await promise;
      } catch (err) {
        const e = err as AramoError;
        expect(e.code).toBe('ENGAGEMENT_EVENT_REF_NOT_FOUND');
        expect(e.statusCode).toBe(422);
        // Cross-tenant: findByTenantAndId returns null because the
        // tenant_id WHERE clause filters out the TENANT_B row even
        // though the UUID itself exists.
        expect(e.context.details?.['engagement_event_ref']).toBe(TENANT_B_EVENT);
        expect(e.context.details?.['input_tenant_id']).toBe(TENANT_A);
      }
    });
  },
);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function seedExamination(
  client: PrismaService,
  opts: {
    id: string;
    tenant_id: string;
    talent_id: string;
    job_id: string;
  },
): Promise<void> {
  const skillMatch = { matched_count: 5, missing_count: 0, per_skill: [] };
  const experienceMatch = { years: 7, summary: 'Strong overlap' };
  const constraintChecks = { location: 'pass', work_mode: 'pass' };
  const expandedReasoning: unknown[] = [];
  const strengths = ['typescript-expertise'];
  const gaps: string[] = [];
  const riskFlags: unknown[] = [];
  const confidenceIndicators = {
    evidence_strength: { level: 'high', basis: 'ingested-evidence' },
    data_completeness: { level: 'high', basis: 'profile-complete' },
    constraint_confidence: { level: 'high', basis: 'verified' },
  };
  const freshnessIndicator = { profile_age_days: 14 };
  await client.$executeRawUnsafe(
    `INSERT INTO examination."TalentJobExamination" (
       id, tenant_id, talent_id, job_id, golden_profile_id,
       trigger, tier, rank_ordinal,
       why_matched_sentence, match_summary,
       expanded_reasoning, skill_match, experience_match,
       constraint_checks, strengths, gaps, risk_flags,
       confidence_indicators, freshness_indicator, delta_to_entrustable,
       examination_version, model_version, taxonomy_version,
       computed_at, lifecycle_state, archived_at, superseded_by_examination_id
     ) VALUES (
       '${opts.id}'::uuid,
       '${opts.tenant_id}'::uuid,
       '${opts.talent_id}'::uuid,
       '${opts.job_id}'::uuid,
       '${GOLDEN_PROFILE_ID}'::uuid,
       'initial_match'::examination."ExaminationTrigger",
       'ENTRUSTABLE'::examination."ExaminationTier",
       1,
       'Strong overlap on critical role requirements.',
       'Sample match summary.',
       '${JSON.stringify(expandedReasoning)}'::jsonb,
       '${JSON.stringify(skillMatch)}'::jsonb,
       '${JSON.stringify(experienceMatch)}'::jsonb,
       '${JSON.stringify(constraintChecks)}'::jsonb,
       '${JSON.stringify(strengths)}'::jsonb,
       '${JSON.stringify(gaps)}'::jsonb,
       '${JSON.stringify(riskFlags)}'::jsonb,
       '${JSON.stringify(confidenceIndicators)}'::jsonb,
       '${JSON.stringify(freshnessIndicator)}'::jsonb,
       NULL,
       'v1.0', 'v1.0', 'v1.0',
       '2026-05-25T09:00:00Z'::timestamptz,
       'active'::examination."ExaminationLifecycleState",
       NULL,
       NULL
     )`,
  );
}

async function seedEngagement(
  client: PrismaService,
  opts: { id: string; tenant_id: string },
): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO engagement."TalentJobEngagement" (
       id, tenant_id, talent_id, requisition_id, state
     ) VALUES (
       '${opts.id}'::uuid,
       '${opts.tenant_id}'::uuid,
       '${TALENT_A}'::uuid,
       '${JOB_ID}'::uuid,
       'surfaced'::engagement."EngagementState"
     )`,
  );
}

async function seedEngagementEvent(
  client: PrismaService,
  opts: {
    id: string;
    tenant_id: string;
    engagement_id: string;
    event_type: string;
    event_payload: unknown;
  },
): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO engagement."TalentEngagementEvent" (
       id, tenant_id, engagement_id, event_type, event_payload
     ) VALUES (
       '${opts.id}'::uuid,
       '${opts.tenant_id}'::uuid,
       '${opts.engagement_id}'::uuid,
       '${opts.event_type}'::engagement."EngagementEventType",
       '${JSON.stringify(opts.event_payload)}'::jsonb
     )`,
  );
}

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      current += '$$';
      i += 1;
      continue;
    }
    if (ch === ';' && !inDollar) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}
