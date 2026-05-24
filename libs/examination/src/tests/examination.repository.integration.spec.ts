import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

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
const OVERRIDE_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260523180000_add_examination_override/migration.sql',
);
const OVERRIDE_TIMESTAMPTZ_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260524080000_add_timestamptz_to_examination_override/migration.sql',
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
      for (const migrationPath of [
        MIGRATION_PATH,
        LIVE_LIST_MIGRATION_PATH,
        // M4 PR-5 §4.11 — apply override migration so the new
        // describe block below can round-trip ExaminationOverride writes.
        OVERRIDE_MIGRATION_PATH,
        // M4-close HK-PR-3 / F41 — apply TIMESTAMPTZ migration that
        // promotes ExaminationOverride.created_at to TIMESTAMP WITH
        // TIME ZONE (aligns with workspace-wide @db.Timestamptz
        // convention).
        OVERRIDE_TIMESTAMPTZ_MIGRATION_PATH,
      ]) {
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

// =====================================================================
// M4 PR-5 §4.11 — ExaminationRepository override methods integration.
// Round-trips createOverride / findOverride* against real Postgres 17
// AND verifies the absolute-immutability trigger + state-isolation
// byte-identity invariant (createOverride does NOT mutate the referenced
// TalentJobExamination row).
// =====================================================================


const OVERRIDE_TENANT = '11111111-1111-7111-8111-111111111111';
const OVERRIDE_TENANT_B = '22222222-2222-7222-8222-222222222222';
const OVERRIDE_TALENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const OVERRIDE_JOB = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const OVERRIDE_RECRUITER = '00000000-0000-7000-8000-0000000000bb';
const OVERRIDE_EXAM_ID = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeee01';
const OVERRIDE_EXAM_ARCHIVED = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeee02';

function hashTjeRow(row: Record<string, unknown>): string {
  const sortedKeys = Object.keys(row).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    const v = row[k];
    canonical[k] = v instanceof Date ? v.toISOString() : v;
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'ExaminationRepository override methods — integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: ExaminationRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const migrationPath of [
        MIGRATION_PATH,
        LIVE_LIST_MIGRATION_PATH,
        OVERRIDE_MIGRATION_PATH,
        OVERRIDE_TIMESTAMPTZ_MIGRATION_PATH,
      ]) {
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

      // Seed an active examination + an archived examination for the
      // refusal-path tests.
      await repo.createSnapshot(
        makeSnapshot({
          id: OVERRIDE_EXAM_ID,
          tenant_id: OVERRIDE_TENANT,
          talent_id: OVERRIDE_TALENT,
          job_id: OVERRIDE_JOB,
        }),
      );
      const archived = makeSnapshot({
        id: OVERRIDE_EXAM_ARCHIVED,
        tenant_id: OVERRIDE_TENANT,
        talent_id: OVERRIDE_TALENT,
        job_id: OVERRIDE_JOB,
        computed_at: new Date('2026-05-21T09:00:00Z'),
      });
      await repo.createSnapshot(archived);
      await repo.markSuperseded({
        prior_id: OVERRIDE_EXAM_ARCHIVED,
        superseded_by_examination_id: OVERRIDE_EXAM_ID,
        lifecycle_state: 'archived',
        archived_at: new Date('2026-05-22T09:00:00Z'),
      });
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('1. successful createOverride: examination row byte-identical pre/post (state isolation)', async () => {
      // Snapshot the examination row before creating the override.
      const preRow = await prisma.talentJobExamination.findUnique({
        where: { id: OVERRIDE_EXAM_ID },
      });
      expect(preRow).not.toBeNull();
      const preHash = hashTjeRow(preRow as unknown as Record<string, unknown>);

      const view = await repo.createOverride({
        tenant_id: OVERRIDE_TENANT,
        examination_id: OVERRIDE_EXAM_ID,
        override_type: 'tier',
        target_field: 'tier',
        justification: 'Recruiter sees stronger evidence than the system-assigned tier.',
        created_by: OVERRIDE_RECRUITER,
      });
      expect(view.examination_id).toBe(OVERRIDE_EXAM_ID);
      expect(view.override_type).toBe('tier');

      // Re-read the examination row + verify byte-identity.
      const postRow = await prisma.talentJobExamination.findUnique({
        where: { id: OVERRIDE_EXAM_ID },
      });
      expect(postRow).not.toBeNull();
      const postHash = hashTjeRow(postRow as unknown as Record<string, unknown>);
      expect(postHash).toBe(preHash);
    });

    it('2. examination-not-found → NOT_FOUND refusal', async () => {
      await expect(
        repo.createOverride({
          tenant_id: OVERRIDE_TENANT,
          examination_id: 'ffffffff-ffff-7fff-8fff-ffffffffffff',
          override_type: 'risk_flag',
          target_field: 'risk_flags',
          justification: 'no such exam',
          created_by: OVERRIDE_RECRUITER,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('3. archived examination → NOT_FOUND refusal', async () => {
      await expect(
        repo.createOverride({
          tenant_id: OVERRIDE_TENANT,
          examination_id: OVERRIDE_EXAM_ARCHIVED,
          override_type: 'tier',
          target_field: 'tier',
          justification: 'cannot override archived',
          created_by: OVERRIDE_RECRUITER,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('4. absolute immutability trigger: UPDATE on ExaminationOverride raises', async () => {
      // Capture an existing override row id from test #1.
      const existing = await repo.findOverridesByExaminationId({
        tenant_id: OVERRIDE_TENANT,
        examination_id: OVERRIDE_EXAM_ID,
      });
      expect(existing.length).toBeGreaterThan(0);
      const overrideId = existing[0]!.id;

      // Direct UPDATE via raw SQL — the trigger MUST raise.
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE examination."ExaminationOverride" SET justification = 'tampered' WHERE id = '${overrideId}'`,
        ),
      ).rejects.toThrow(/absolutely immutable/);
    });

    it('5. multiple overrides on same examination — examination row byte-identical across all', async () => {
      const preRow = await prisma.talentJobExamination.findUnique({
        where: { id: OVERRIDE_EXAM_ID },
      });
      const preHash = hashTjeRow(preRow as unknown as Record<string, unknown>);

      for (const type of ['risk_flag', 'gap', 'constraint_check'] as const) {
        await repo.createOverride({
          tenant_id: OVERRIDE_TENANT,
          examination_id: OVERRIDE_EXAM_ID,
          override_type: type,
          target_field: type === 'gap' ? 'gaps' : type,
          justification: `${type} override rationale`,
          created_by: OVERRIDE_RECRUITER,
        });

        const postRow = await prisma.talentJobExamination.findUnique({
          where: { id: OVERRIDE_EXAM_ID },
        });
        const postHash = hashTjeRow(postRow as unknown as Record<string, unknown>);
        expect(postHash).toBe(preHash);
      }
    });

    it('6. tenant isolation: createOverride for examination owned by another tenant → NOT_FOUND', async () => {
      await expect(
        repo.createOverride({
          tenant_id: OVERRIDE_TENANT_B,
          examination_id: OVERRIDE_EXAM_ID,
          override_type: 'tier',
          target_field: 'tier',
          justification: 'cross-tenant attempt',
          created_by: OVERRIDE_RECRUITER,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('7. enum closed-list rejection via raw SQL (invalid OverrideType value)', async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO examination."ExaminationOverride"
             (id, tenant_id, examination_id, override_type, target_field, justification, created_by, created_at)
           VALUES ('99999999-9999-7999-8999-999999999999',
                   '${OVERRIDE_TENANT}',
                   '${OVERRIDE_EXAM_ID}',
                   'invalid_type',
                   'tier',
                   'bypass attempt',
                   '${OVERRIDE_RECRUITER}',
                   NOW())`,
        ),
      ).rejects.toThrow();
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
