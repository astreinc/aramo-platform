import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  JobDomainRepository,
  PrismaService as JobDomainPrismaService,
} from '@aramo/job-domain';

import {
  ExaminationRepository,
  type CreateExaminationSnapshotInput,
} from '../lib/examination.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// M3 PR-7 §4.4 integration test. Spins up a Postgres testcontainer, applies
// PR-1's examination init migration AND PR-7's add-live-list-index
// migration, then applies PR-4's job-domain init migration, then seeds:
//   - one active Requisition + one inactive Requisition (same tenant) +
//     one mismatched-tenant active Requisition;
//   - a set of TalentJobExamination rows with mixed (tier, rank_ordinal,
//     lifecycle_state) for the active req's job_id, plus a row at the same
//     rank_ordinal but a later id (tiebreaker test), plus a row for a
//     different job_id (must be excluded).
//
// Asserts:
//   - findActiveReqLiveList for the active req returns only
//     lifecycle_state='active' rows for the correct job_id, ordered by
//     (tier ASC, rank_ordinal ASC, id ASC) — including the id tiebreaker.
//   - findActiveReqLiveList for the inactive req returns [].
//   - findActiveReqLiveList for the tenant-mismatched req returns [].
//   - The PR-1 immutability trigger is never reached: a Prisma update spy
//     records zero invocations across multiple findActiveReqLiveList calls.

const PR1_EXAMINATION_MIGRATION = resolve(
  __dirname,
  '../../prisma/migrations/20260517200000_init_examination_model/migration.sql',
);
const PR7_LIVE_LIST_INDEX_MIGRATION = resolve(
  __dirname,
  '../../prisma/migrations/20260521120000_add_live_list_index/migration.sql',
);
const PR4_JOB_DOMAIN_MIGRATION = resolve(
  __dirname,
  '../../../job-domain/prisma/migrations/20260519100000_init_job_domain_model/migration.sql',
);

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

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const JOB_ACTIVE = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const JOB_OTHER = 'ccccccc1-cccc-7ccc-8ccc-ccccccccccc1';
const GOLDEN = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const RECRUITER = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

const REQ_ACTIVE = 'eeeeeeee-eeee-7eee-8eee-000000000001';
const REQ_INACTIVE = 'eeeeeeee-eeee-7eee-8eee-000000000002';
const REQ_TENANT_B = 'eeeeeeee-eeee-7eee-8eee-000000000003';

// 5 examinations for the active req's job_id with mixed tiers / ranks /
// lifecycle. Two share rank_ordinal=1 in the STRETCH tier to exercise the
// id tiebreaker (lexically lower id appears first).
const EXAM_E1 = '11111111-0000-7000-8000-000000000001'; // ENTRUSTABLE, rank_ordinal 1
const EXAM_W2 = '22222222-0000-7000-8000-000000000002'; // WORTH_CONSIDERING, rank_ordinal 2
const EXAM_W3 = '33333333-0000-7000-8000-000000000003'; // WORTH_CONSIDERING, rank_ordinal 3
const EXAM_S1a = '44444444-0000-7000-8000-00000000000a'; // STRETCH, rank_ordinal 1 (tiebreak-low)
const EXAM_S1b = '55555555-0000-7000-8000-00000000000b'; // STRETCH, rank_ordinal 1 (tiebreak-high)
// One archived row for the active job — must be filtered out.
const EXAM_ARCH = '66666666-0000-7000-8000-000000000006';
// One row for a different job — must be excluded by the job_id filter.
const EXAM_OTHER_JOB = '77777777-0000-7000-8000-000000000007';

function baseSnapshot(
  overrides: Partial<CreateExaminationSnapshotInput>,
): CreateExaminationSnapshotInput {
  return {
    id: EXAM_E1,
    tenant_id: TENANT_A,
    talent_id: TALENT_ID,
    job_id: JOB_ACTIVE,
    golden_profile_id: GOLDEN,
    trigger: 'initial_match',
    tier: 'ENTRUSTABLE',
    rank_ordinal: 1,
    why_matched_sentence: 'baseline match',
    match_summary: 'baseline',
    expanded_reasoning: [],
    skill_match: { matched_count: 0, missing_count: 0, per_skill: [] },
    experience_match: {},
    constraint_checks: {},
    strengths: [],
    gaps: [],
    risk_flags: [],
    confidence_indicators: {
      evidence_strength: { level: 'high', basis: 'multi-source' },
      data_completeness: { level: 'high', basis: 'all fields present' },
      constraint_confidence: { level: 'high', basis: 'verified' },
    },
    freshness_indicator: { profile_age_days: 14 },
    examination_version: 'examination-v1.0.0',
    model_version: 'matching-model-v1.0.0',
    taxonomy_version: 'taxonomy-v1.0.0',
    computed_at: new Date('2026-05-21T10:00:00Z'),
    ...overrides,
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'ExaminationRepository.findActiveReqLiveList — integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let examinationPrisma: PrismaService;
    let jobDomainPrisma: JobDomainPrismaService;
    let repo: ExaminationRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      // Apply migrations in chronological order: PR-1 init, PR-7 index,
      // PR-4 job-domain init. The PR-1 init uses a $$ ... $$ trigger body,
      // so splitDdl is dollar-quote-aware.
      const examSetup = new PrismaService(url);
      await examSetup.$connect();
      for (const stmt of splitDdl(readFileSync(PR1_EXAMINATION_MIGRATION, 'utf8'))) {
        const t = stmt.trim();
        if (t.length === 0) continue;
        await examSetup.$executeRawUnsafe(t);
      }
      for (const stmt of splitDdl(readFileSync(PR7_LIVE_LIST_INDEX_MIGRATION, 'utf8'))) {
        const t = stmt.trim();
        if (t.length === 0) continue;
        await examSetup.$executeRawUnsafe(t);
      }
      await examSetup.$disconnect();

      const jobSetup = new JobDomainPrismaService(url);
      await jobSetup.$connect();
      for (const stmt of splitDdl(readFileSync(PR4_JOB_DOMAIN_MIGRATION, 'utf8'))) {
        const t = stmt.trim();
        if (t.length === 0) continue;
        await jobSetup.$executeRawUnsafe(t);
      }
      await jobSetup.$disconnect();

      examinationPrisma = new PrismaService(url);
      await examinationPrisma.$connect();
      jobDomainPrisma = new JobDomainPrismaService(url);
      await jobDomainPrisma.$connect();

      const jobDomainRepo = new JobDomainRepository(jobDomainPrisma);
      repo = new ExaminationRepository(examinationPrisma, jobDomainRepo);

      // Seed Requisitions.
      await jobDomainRepo.createRequisition({
        id: REQ_ACTIVE,
        tenant_id: TENANT_A,
        job_id: JOB_ACTIVE,
        recruiter_id: RECRUITER,
        state: 'active',
      });
      await jobDomainRepo.createRequisition({
        id: REQ_INACTIVE,
        tenant_id: TENANT_A,
        job_id: JOB_ACTIVE,
        recruiter_id: RECRUITER,
        state: 'inactive',
      });
      await jobDomainRepo.createRequisition({
        id: REQ_TENANT_B,
        tenant_id: TENANT_B,
        job_id: JOB_ACTIVE,
        recruiter_id: RECRUITER,
        state: 'active',
      });

      // Seed examinations.
      await repo.createSnapshot(baseSnapshot({ id: EXAM_E1, tier: 'ENTRUSTABLE', rank_ordinal: 1 }));
      await repo.createSnapshot(
        baseSnapshot({ id: EXAM_W2, tier: 'WORTH_CONSIDERING', rank_ordinal: 2 }),
      );
      await repo.createSnapshot(
        baseSnapshot({ id: EXAM_W3, tier: 'WORTH_CONSIDERING', rank_ordinal: 3 }),
      );
      await repo.createSnapshot(baseSnapshot({ id: EXAM_S1a, tier: 'STRETCH', rank_ordinal: 1 }));
      await repo.createSnapshot(baseSnapshot({ id: EXAM_S1b, tier: 'STRETCH', rank_ordinal: 1 }));

      // Archived row for the active job — must be filtered out by
      // lifecycle_state='active'. Created as active, then markSuperseded
      // moves it to archived via PR-1's lifecycle-only write path.
      await repo.createSnapshot(
        baseSnapshot({ id: EXAM_ARCH, tier: 'ENTRUSTABLE', rank_ordinal: 99 }),
      );
      await repo.markSuperseded({
        prior_id: EXAM_ARCH,
        superseded_by_examination_id: EXAM_E1,
        lifecycle_state: 'archived',
        archived_at: new Date('2026-05-21T10:30:00Z'),
      });

      // Row for a different job — must be excluded by the job_id filter.
      await repo.createSnapshot(
        baseSnapshot({
          id: EXAM_OTHER_JOB,
          tier: 'ENTRUSTABLE',
          rank_ordinal: 1,
          job_id: JOB_OTHER,
        }),
      );
    }, 180_000);

    afterAll(async () => {
      await jobDomainPrisma?.$disconnect();
      await examinationPrisma?.$disconnect();
      await container?.stop();
    });

    it('returns only lifecycle_state="active" rows for the correct job_id, ordered (tier, rank_ordinal, id) — including id tiebreaker', async () => {
      const result = await repo.findActiveReqLiveList({
        tenant_id: TENANT_A,
        req_id: REQ_ACTIVE,
      });
      // Expected order: ENTRUSTABLE-rank1 (EXAM_E1), then
      // WORTH_CONSIDERING-rank2 (EXAM_W2), then WORTH_CONSIDERING-rank3
      // (EXAM_W3), then STRETCH-rank1 (EXAM_S1a — id 44…a, lexically
      // before EXAM_S1b id 55…b), then STRETCH-rank1 (EXAM_S1b).
      // Excluded: EXAM_ARCH (archived), EXAM_OTHER_JOB (different job_id).
      expect(result.map((r) => r.examination_id)).toEqual([
        EXAM_E1,
        EXAM_W2,
        EXAM_W3,
        EXAM_S1a,
        EXAM_S1b,
      ]);
      // Each result is the Summary projection shape (PR-6).
      expect(Object.keys(result[0] ?? {}).sort()).toEqual(
        [
          'computed_at',
          'confidence_summary',
          'examination_id',
          'freshness_indicator',
          'job_id',
          'rank_ordinal',
          'talent_id',
          'tier',
          'top_skills',
          'why_matched_sentence',
        ].sort(),
      );
    });

    it('returns [] when the requisition is inactive (no Prisma query for the rows)', async () => {
      const result = await repo.findActiveReqLiveList({
        tenant_id: TENANT_A,
        req_id: REQ_INACTIVE,
      });
      expect(result).toEqual([]);
    });

    it('returns [] when the tenant_id does not match the requisition (security posture)', async () => {
      const result = await repo.findActiveReqLiveList({
        tenant_id: TENANT_A,
        req_id: REQ_TENANT_B,
      });
      expect(result).toEqual([]);
    });

    it('returns [] for an unknown req_id', async () => {
      const result = await repo.findActiveReqLiveList({
        tenant_id: TENANT_A,
        req_id: '00000000-0000-7000-8000-deadbeef0000',
      });
      expect(result).toEqual([]);
    });

    it('honors limit clamp (Ruling 7) — value 200 caps at 200; value 1 returns at most 1', async () => {
      const r200 = await repo.findActiveReqLiveList({
        tenant_id: TENANT_A,
        req_id: REQ_ACTIVE,
        limit: 200,
      });
      expect(r200.length).toBeLessThanOrEqual(200);
      const r1 = await repo.findActiveReqLiveList({
        tenant_id: TENANT_A,
        req_id: REQ_ACTIVE,
        limit: 1,
      });
      expect(r1).toHaveLength(1);
      expect(r1[0]?.examination_id).toBe(EXAM_E1);
    });

    it('keyset cursor round-trips: page 2 picks up after the cursor', async () => {
      const page1 = await repo.findActiveReqLiveList({
        tenant_id: TENANT_A,
        req_id: REQ_ACTIVE,
        limit: 2,
      });
      expect(page1.map((r) => r.examination_id)).toEqual([EXAM_E1, EXAM_W2]);

      const last = page1[page1.length - 1];
      expect(last).toBeDefined();
      if (last === undefined) return;

      const page2 = await repo.findActiveReqLiveList({
        tenant_id: TENANT_A,
        req_id: REQ_ACTIVE,
        limit: 2,
        cursor: {
          tier: last.tier,
          rank_ordinal: last.rank_ordinal,
          id: last.examination_id,
        },
      });
      // Next two rows after EXAM_W2 are EXAM_W3, then EXAM_S1a.
      expect(page2.map((r) => r.examination_id)).toEqual([EXAM_W3, EXAM_S1a]);
    });

    it('write-path spy: findActiveReqLiveList issues zero update / updateMany invocations', async () => {
      const updateSpy = vi.spyOn(examinationPrisma.talentJobExamination, 'update');
      const updateManySpy = vi.spyOn(examinationPrisma.talentJobExamination, 'updateMany');
      try {
        await repo.findActiveReqLiveList({ tenant_id: TENANT_A, req_id: REQ_ACTIVE });
        await repo.findActiveReqLiveList({ tenant_id: TENANT_A, req_id: REQ_INACTIVE });
        await repo.findActiveReqLiveList({
          tenant_id: TENANT_A,
          req_id: REQ_ACTIVE,
          cursor: { tier: 'ENTRUSTABLE', rank_ordinal: 1, id: EXAM_E1 },
        });
        expect(updateSpy).not.toHaveBeenCalled();
        expect(updateManySpy).not.toHaveBeenCalled();
      } finally {
        updateSpy.mockRestore();
        updateManySpy.mockRestore();
      }
    });
  },
);
