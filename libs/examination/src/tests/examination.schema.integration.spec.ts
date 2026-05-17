import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import {
  ExaminationRepository,
  type CreateExaminationSnapshotInput,
} from '../lib/examination.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

const MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260517200000_init_examination_model/migration.sql',
);

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const TALENT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const TALENT_B = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaa999';
const JOB_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const GOLDEN_ID = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';

function baseInput(
  overrides: Partial<CreateExaminationSnapshotInput> = {},
): CreateExaminationSnapshotInput {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    tenant_id: TENANT_A,
    talent_id: TALENT_A,
    job_id: JOB_ID,
    golden_profile_id: GOLDEN_ID,
    trigger: 'initial_match',
    tier: 'ENTRUSTABLE',
    rank_ordinal: 1,
    why_matched_sentence: 'matches all critical skills with strong evidence',
    match_summary: 'Strong evidence across all required dimensions.',
    expanded_reasoning: [
      { category: 'skill', statement: 'Has TypeScript evidence', evidence_refs: [] },
    ],
    skill_match: { matched: 5, missing: 0 },
    experience_match: { years: 8 },
    constraint_checks: { location: 'pass', rate: 'pass' },
    strengths: ['typescript', 'backend'],
    gaps: [],
    risk_flags: [],
    confidence_indicators: {
      evidence_strength: { level: 'high', basis: 'multi-source' },
      data_completeness: { level: 'high', basis: 'all fields present' },
      constraint_confidence: { level: 'high', basis: 'verified' },
    },
    freshness_indicator: { profile_age_days: 14 },
    examination_version: 'exam-v1.0.0',
    model_version: 'model-v1.0.0',
    taxonomy_version: 'taxonomy-v1.0.0',
    computed_at: new Date('2026-05-17T20:00:00Z'),
    ...overrides,
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TalentJobExamination — schema integration (real Postgres 17)',
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
      repo = new ExaminationRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('creates a snapshot with the full §2.4 field set and reads it back by id', async () => {
      const input = baseInput({ id: '00000000-0000-7000-8000-0000000000a1' });
      const created = await repo.createSnapshot(input);
      expect(created.id).toBe(input.id);
      expect(created.tier).toBe('ENTRUSTABLE');
      expect(created.lifecycle_state).toBe('active');
      expect(created.archived_at).toBeNull();
      expect(created.superseded_by_examination_id).toBeNull();
      expect(created.examination_version).toBe('exam-v1.0.0');
      expect(created.model_version).toBe('model-v1.0.0');
      expect(created.taxonomy_version).toBe('taxonomy-v1.0.0');

      const fetched = await repo.findById(input.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(input.id);
      expect(fetched?.confidence_indicators).toMatchObject({
        evidence_strength: { level: 'high' },
      });
    });

    it('findByTenantAndTalent returns newest-first via the (computed_at DESC, id DESC) keyset', async () => {
      const older = baseInput({
        id: '00000000-0000-7000-8000-0000000000b1',
        tenant_id: TENANT_B,
        talent_id: TALENT_B,
        computed_at: new Date('2026-05-15T10:00:00Z'),
      });
      const newer = baseInput({
        id: '00000000-0000-7000-8000-0000000000b2',
        tenant_id: TENANT_B,
        talent_id: TALENT_B,
        computed_at: new Date('2026-05-17T10:00:00Z'),
      });
      await repo.createSnapshot(older);
      await repo.createSnapshot(newer);

      const rows = await repo.findByTenantAndTalent(TENANT_B, TALENT_B);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.id).toBe(newer.id);
      expect(rows[1]?.id).toBe(older.id);
    });

    it('rejects an out-of-vocabulary tier value at the database enum boundary', async () => {
      // Bypass the typed repository to exercise the database enum check
      // directly. Prisma's enum type would reject this at compile time;
      // this asserts the second belt (DB-level enum rejection).
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO examination."TalentJobExamination"
             (id, tenant_id, talent_id, job_id, golden_profile_id,
              trigger, tier, rank_ordinal, why_matched_sentence, match_summary,
              expanded_reasoning, skill_match, experience_match, constraint_checks,
              strengths, gaps, risk_flags, confidence_indicators, freshness_indicator,
              examination_version, model_version, taxonomy_version, computed_at)
           VALUES ('00000000-0000-7000-8000-0000000000c1'::uuid,
                   '${TENANT_A}'::uuid, '${TALENT_A}'::uuid,
                   '${JOB_ID}'::uuid, '${GOLDEN_ID}'::uuid,
                   'initial_match'::examination."ExaminationTrigger",
                   'NOT_A_TIER'::examination."ExaminationTier",
                   1, 'x', 'x',
                   '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
                   '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb,
                   'v1', 'v1', 'v1', '2026-05-17T20:00:00Z')`,
        ),
      ).rejects.toThrow();
    });

    it('rejects a NULL on a required version-pin column (NOT NULL constraint)', async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO examination."TalentJobExamination"
             (id, tenant_id, talent_id, job_id, golden_profile_id,
              trigger, tier, rank_ordinal, why_matched_sentence, match_summary,
              expanded_reasoning, skill_match, experience_match, constraint_checks,
              strengths, gaps, risk_flags, confidence_indicators, freshness_indicator,
              examination_version, model_version, taxonomy_version, computed_at)
           VALUES ('00000000-0000-7000-8000-0000000000c2'::uuid,
                   '${TENANT_A}'::uuid, '${TALENT_A}'::uuid,
                   '${JOB_ID}'::uuid, '${GOLDEN_ID}'::uuid,
                   'initial_match'::examination."ExaminationTrigger",
                   'ENTRUSTABLE'::examination."ExaminationTier",
                   1, 'x', 'x',
                   '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
                   '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb,
                   NULL, 'v1', 'v1', '2026-05-17T20:00:00Z')`,
        ),
      ).rejects.toThrow();
    });
  },
);

// Dollar-quote-aware DDL splitter — required because the migration
// contains a PL/pgSQL trigger body wrapped in `$$ … $$`. A naive ;-split
// would break inside the function body. Mirrors libs/consent/src/tests/
// consent.integration.spec.ts splitDdl (M3 PR-1 §3.4 substrate ruling).
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
