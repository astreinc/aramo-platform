import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import {
  ExaminationRepository,
  type CreateExaminationSnapshotInput,
} from '../lib/examination.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// M4 PR-4 §4.1 — integration spec for findLatestByTenantTalentJob against
// a real Postgres 17 container. Round-trips ordering + lifecycle filter +
// tenant isolation.

const MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260517200000_init_examination_model/migration.sql',
);
const LIVE_LIST_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260521120000_add_live_list_index/migration.sql',
);

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const TALENT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const JOB_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const GOLDEN_ID = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';

function makeSnapshot(
  overrides: Partial<CreateExaminationSnapshotInput>,
): CreateExaminationSnapshotInput {
  return {
    id: overrides.id ?? '00000000-0000-7000-8000-000000000001',
    tenant_id: overrides.tenant_id ?? TENANT_A,
    talent_id: overrides.talent_id ?? TALENT_A,
    job_id: overrides.job_id ?? JOB_ID,
    golden_profile_id: GOLDEN_ID,
    trigger: 'initial_match',
    tier: overrides.tier ?? 'ENTRUSTABLE',
    rank_ordinal: overrides.rank_ordinal ?? 1,
    why_matched_sentence: 'baseline match',
    match_summary: 'baseline',
    expanded_reasoning: [],
    skill_match: { matched_count: 5, missing_count: 0, per_skill: [] },
    experience_match: { years: 7, summary: 'Strong overlap' },
    constraint_checks: {},
    strengths: ['typescript-expertise'],
    gaps: [],
    risk_flags: [],
    confidence_indicators: {
      evidence_strength: { level: 'high', basis: 'ingested-evidence' },
      data_completeness: { level: 'high', basis: 'profile-complete' },
      constraint_confidence: { level: 'high', basis: 'verified' },
    },
    freshness_indicator: { profile_age_days: 14 },
    examination_version: 'exam-v1.0.0',
    model_version: 'model-v1.0.0',
    taxonomy_version: 'taxonomy-v1.0.0',
    computed_at: overrides.computed_at ?? new Date('2026-05-22T09:00:00Z'),
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'ExaminationRepository.findLatestByTenantTalentJob — integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: ExaminationRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const migrationPath of [MIGRATION_PATH, LIVE_LIST_MIGRATION_PATH]) {
        const migrationSql = readFileSync(migrationPath, 'utf8');
        for (const stmt of splitDdl(migrationSql)) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setupClient.$executeRawUnsafe(trimmed);
        }
      }
      await setupClient.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new ExaminationRepository(prisma, undefined as never);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('1. three examinations same (tenant, talent, job) triple → latest returned', async () => {
      // Seed three snapshots with strictly-increasing computed_at; the
      // third is the latest.
      await repo.createSnapshot(
        makeSnapshot({
          id: '00000000-0000-7000-8000-000000000a01',
          computed_at: new Date('2026-05-20T09:00:00Z'),
        }),
      );
      await repo.createSnapshot(
        makeSnapshot({
          id: '00000000-0000-7000-8000-000000000a02',
          computed_at: new Date('2026-05-21T09:00:00Z'),
        }),
      );
      await repo.createSnapshot(
        makeSnapshot({
          id: '00000000-0000-7000-8000-000000000a03',
          computed_at: new Date('2026-05-22T09:00:00Z'),
        }),
      );

      const latest = await repo.findLatestByTenantTalentJob({
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        job_id: JOB_ID,
      });
      expect(latest).not.toBeNull();
      expect(latest?.id).toBe('00000000-0000-7000-8000-000000000a03');
    });

    it('2. archive the latest snapshot → second-latest returned (lifecycle filter)', async () => {
      // Archive the latest via markSuperseded; the second-latest active
      // becomes the new newest.
      await repo.markSuperseded({
        prior_id: '00000000-0000-7000-8000-000000000a03',
        superseded_by_examination_id: '00000000-0000-7000-8000-000000000a02',
        lifecycle_state: 'archived',
        archived_at: new Date('2026-05-22T10:00:00Z'),
      });

      const latest = await repo.findLatestByTenantTalentJob({
        tenant_id: TENANT_A,
        talent_id: TALENT_A,
        job_id: JOB_ID,
      });
      expect(latest).not.toBeNull();
      expect(latest?.id).toBe('00000000-0000-7000-8000-000000000a02');
      expect(latest?.lifecycle_state).toBe('active');
    });

    it('3. cross-tenant query returns null (no row for the named tenant)', async () => {
      const latest = await repo.findLatestByTenantTalentJob({
        tenant_id: TENANT_B,
        talent_id: TALENT_A,
        job_id: JOB_ID,
      });
      expect(latest).toBeNull();
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
