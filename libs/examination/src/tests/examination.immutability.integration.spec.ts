import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { ExaminationRepository } from '../lib/examination.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

const MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260517200000_init_examination_model/migration.sql',
);

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const JOB_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const GOLDEN_ID = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TalentJobExamination — column-scoped immutability trigger (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: ExaminationRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');

      const setupClient = new PrismaService(url);
      await setupClient.$connect();
      const statements = splitDdl(migrationSql);
      for (const stmt of statements) {
        const trimmed = stmt.trim();
        if (trimmed.length === 0) continue;
        await setupClient.$executeRawUnsafe(trimmed);
      }
      await setupClient.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      // PR-7 added JobDomainRepository as a constructor dep for the
      // findActiveReqLiveList Live List query. This spec doesn't exercise
      // that method, so the dep is `undefined as never`.
      repo = new ExaminationRepository(prisma, undefined as never);

      // Seed one snapshot the immutability tests mutate against.
      await repo.createSnapshot({
        id: '00000000-0000-7000-8000-0000000000d1',
        tenant_id: TENANT_ID,
        talent_id: TALENT_ID,
        job_id: JOB_ID,
        golden_profile_id: GOLDEN_ID,
        trigger: 'initial_match',
        tier: 'ENTRUSTABLE',
        rank_ordinal: 1,
        why_matched_sentence: 'matches all critical skills',
        match_summary: 'Strong.',
        expanded_reasoning: [],
        skill_match: { matched: 5, missing: 0 },
        experience_match: {},
        constraint_checks: {},
        strengths: [],
        gaps: [],
        risk_flags: [],
        confidence_indicators: {},
        freshness_indicator: {},
        examination_version: 'exam-v1.0.0',
        model_version: 'model-v1.0.0',
        taxonomy_version: 'taxonomy-v1.0.0',
        computed_at: new Date('2026-05-17T20:00:00Z'),
      });
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('rejects an UPDATE that touches an analytical column (tier)', async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE examination."TalentJobExamination"
             SET tier = 'STRETCH'::examination."ExaminationTier"
             WHERE id = '00000000-0000-7000-8000-0000000000d1'::uuid`,
        ),
      ).rejects.toThrow(/analytical fields are immutable/);
    });

    it('rejects an UPDATE that touches a version-pin column (examination_version)', async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE examination."TalentJobExamination"
             SET examination_version = 'exam-v2.0.0'
             WHERE id = '00000000-0000-7000-8000-0000000000d1'::uuid`,
        ),
      ).rejects.toThrow(/analytical fields are immutable/);
    });

    it('rejects an UPDATE that touches a Json analytical column (expanded_reasoning)', async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE examination."TalentJobExamination"
             SET expanded_reasoning = '[{"category":"skill"}]'::jsonb
             WHERE id = '00000000-0000-7000-8000-0000000000d1'::uuid`,
        ),
      ).rejects.toThrow(/analytical fields are immutable/);
    });

    it('permits a lifecycle-only UPDATE: active → archived via markSuperseded', async () => {
      // Seed a second snapshot to act as the supersession target.
      await repo.createSnapshot({
        id: '00000000-0000-7000-8000-0000000000d2',
        tenant_id: TENANT_ID,
        talent_id: TALENT_ID,
        job_id: JOB_ID,
        golden_profile_id: GOLDEN_ID,
        trigger: 'model_recompute',
        tier: 'ENTRUSTABLE',
        rank_ordinal: 1,
        why_matched_sentence: 'recomputed under new model',
        match_summary: 'Refreshed snapshot.',
        expanded_reasoning: [],
        skill_match: {},
        experience_match: {},
        constraint_checks: {},
        strengths: [],
        gaps: [],
        risk_flags: [],
        confidence_indicators: {},
        freshness_indicator: {},
        examination_version: 'exam-v1.0.0',
        model_version: 'model-v2.0.0',
        taxonomy_version: 'taxonomy-v1.0.0',
        computed_at: new Date('2026-05-18T10:00:00Z'),
      });

      const archivedAt = new Date('2026-05-18T10:00:01Z');
      const result = await repo.markSuperseded({
        prior_id: '00000000-0000-7000-8000-0000000000d1',
        superseded_by_examination_id: '00000000-0000-7000-8000-0000000000d2',
        lifecycle_state: 'archived',
        archived_at: archivedAt,
      });

      expect(result.lifecycle_state).toBe('archived');
      expect(result.archived_at?.toISOString()).toBe(archivedAt.toISOString());
      expect(result.superseded_by_examination_id).toBe(
        '00000000-0000-7000-8000-0000000000d2',
      );
      // Analytical fields unchanged after the lifecycle transition.
      expect(result.tier).toBe('ENTRUSTABLE');
      expect(result.examination_version).toBe('exam-v1.0.0');
    });

    it('permits a lifecycle-only UPDATE: archived → cold_storage via raw SQL', async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE examination."TalentJobExamination"
             SET lifecycle_state = 'cold_storage'::examination."ExaminationLifecycleState"
             WHERE id = '00000000-0000-7000-8000-0000000000d1'::uuid`,
        ),
      ).resolves.toBe(1);
    });

    it('rejects a mixed UPDATE that touches BOTH a lifecycle and an analytical column', async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE examination."TalentJobExamination"
             SET lifecycle_state = 'active'::examination."ExaminationLifecycleState",
                 tier = 'STRETCH'::examination."ExaminationTier"
             WHERE id = '00000000-0000-7000-8000-0000000000d1'::uuid`,
        ),
      ).rejects.toThrow(/analytical fields are immutable/);
    });
  },
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
