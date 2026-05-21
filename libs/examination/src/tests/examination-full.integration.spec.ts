import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import {
  ExaminationRepository,
  type CreateExaminationSnapshotInput,
} from '../lib/examination.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// M3 PR-6 §4.4 integration test. Persists a TalentJobExamination row via
// PR-1's createSnapshot path, then exercises the PR-6 findByIdFull /
// findByIdSummary projections against the real Postgres testcontainer.
//
// Asserts:
//   - findByIdFull returns the structured TalentJobExaminationFullView with
//     the persisted Json correctly typed at the boundary.
//   - findByIdSummary returns the Summary view (the allOf base).
//   - The evidence_references aggregate flattens evidence_refs across
//     expanded_reasoning entries, project-only — UUIDs are forwarded
//     verbatim with no dereferencing of libs/talent-evidence (PR-6 §2
//     Ruling 2).
//   - The projection issues NO UPDATE: the PR-1 immutability trigger is
//     never invoked because Full is a read view; a Prisma spy across
//     `update` / `updateMany` confirms zero calls during projection.
//   - findByIdFull returns null for an unknown id.
//
// Applies PR-1's migration via the dollar-quote-aware splitDdl helper.

const PR1_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260517200000_init_examination_model/migration.sql',
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

const TENANT = '11111111-1111-7111-8111-111111111111';
const TALENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const JOB_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const GOLDEN_ID = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';

function baseInput(
  overrides: Partial<CreateExaminationSnapshotInput> = {},
): CreateExaminationSnapshotInput {
  return {
    id: '00000000-0000-7000-8000-0000000000f6',
    tenant_id: TENANT,
    talent_id: TALENT,
    job_id: JOB_ID,
    golden_profile_id: GOLDEN_ID,
    trigger: 'initial_match',
    tier: 'WORTH_CONSIDERING',
    rank_ordinal: 4,
    why_matched_sentence: 'Strong Java/Spring match with recent AWS exposure.',
    match_summary: 'Strong fit across required dimensions.',
    expanded_reasoning: [
      {
        category: 'skill',
        statement: 'TypeScript evidence is multi-source.',
        evidence_refs: [
          {
            entity_type: 'TalentSkillEvidence',
            entity_id: '22222222-2222-7222-8222-222222222222',
            field_path: 'surface_form',
            excerpt: 'TypeScript',
          },
        ],
      },
      {
        category: 'experience',
        statement: 'Eight years of backend experience.',
        evidence_refs: [
          {
            entity_type: 'TalentWorkHistoryEntry',
            entity_id: '33333333-3333-7333-8333-333333333333',
          },
        ],
      },
    ],
    skill_match: {
      matched_count: 2,
      missing_count: 0,
      per_skill: [
        { name: 'TypeScript', evidence_count: 4, has_ingested_evidence: true },
        { name: 'AWS', evidence_count: 2, has_ingested_evidence: true },
      ],
    },
    experience_match: { years: 8 },
    constraint_checks: { location: 'pass', rate: 'partial' },
    strengths: ['typescript', 'backend'],
    gaps: ['kubernetes'],
    risk_flags: [
      { type: 'rate_mismatch', severity: 'medium', message: 'Target rate slightly above band' },
    ],
    confidence_indicators: {
      evidence_strength: { level: 'high', basis: 'multi-source' },
      data_completeness: { level: 'high', basis: 'all fields present' },
      constraint_confidence: { level: 'medium', basis: 'rate not yet confirmed' },
    },
    freshness_indicator: { profile_age_days: 14 },
    delta_to_entrustable: {
      current_tier: 'WORTH_CONSIDERING',
      next_tier_target: 'ENTRUSTABLE',
      blockers: ['rate_mismatch'],
      recommended_actions: ['Confirm rate'],
    },
    examination_version: 'examination-v1.0.0',
    model_version: 'matching-model-v1.0.0',
    taxonomy_version: 'taxonomy-v1.0.0',
    computed_at: new Date('2026-05-19T22:00:00Z'),
    ...overrides,
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'ExaminationRepository — Full projection integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: ExaminationRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const migrationSql = readFileSync(PR1_MIGRATION_PATH, 'utf8');
      const setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const stmt of splitDdl(migrationSql)) {
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
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('findByIdFull projects the persisted Json into the structured TalentJobExaminationFullView', async () => {
      const input = baseInput();
      await repo.createSnapshot(input);

      const view = await repo.findByIdFull(input.id);
      expect(view).not.toBeNull();
      if (view === null) return;

      // Summary (allOf base) — typed correctly.
      expect(view.examination_id).toBe(input.id);
      expect(view.tier).toBe('WORTH_CONSIDERING');
      expect(view.rank_ordinal).toBe(4);
      expect(view.top_skills).toEqual(['TypeScript', 'AWS']);

      // Fully-specified additions — Group 2 §2.4 byte-faithful.
      expect(view.expanded_reasoning).toHaveLength(2);
      expect(view.expanded_reasoning[0]?.category).toBe('skill');
      expect(view.expanded_reasoning[0]?.evidence_refs[0]?.entity_type).toBe('TalentSkillEvidence');

      expect(view.risk_flags).toHaveLength(1);
      expect(view.risk_flags[0]?.type).toBe('rate_mismatch');

      expect(view.confidence_summary.evidence_strength.level).toBe('high');

      expect(view.delta_to_entrustable?.current_tier).toBe('WORTH_CONSIDERING');
      expect(view.delta_to_entrustable?.next_tier_target).toBe('ENTRUSTABLE');

      // Named-only projection (Ruling 1) — name-keyed, no skill_id.
      expect(view.skill_match.matched_count).toBe(2);
      expect(view.skill_match.per_skill[0]?.name).toBe('TypeScript');
      expect(Object.keys(view.skill_match.per_skill[0] ?? {}).sort()).toEqual(
        ['evidence_count', 'has_ingested_evidence', 'name'],
      );

      // Evidence references aggregate — project-only (Ruling 2): UUIDs
      // forwarded verbatim, no resolution from libs/talent-evidence.
      expect(view.evidence_references).toHaveLength(2);
      expect(view.evidence_references[0]?.entity_id).toBe(
        '22222222-2222-7222-8222-222222222222',
      );

      // Lifecycle metadata (already PR-1 columns).
      expect(view.lifecycle_state).toBe('active');
      expect(view.archived_at).toBeNull();
      expect(view.superseded_by_examination_id).toBeNull();
    });

    it('findByIdSummary projects the 10-field Summary view (allOf base)', async () => {
      const id = '00000000-0000-7000-8000-0000000000f7';
      await repo.createSnapshot(baseInput({ id }));

      const view = await repo.findByIdSummary(id);
      expect(view).not.toBeNull();
      if (view === null) return;

      // Exactly the 10 Summary fields per API Contracts v1.0 L433-461.
      expect(Object.keys(view).sort()).toEqual(
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

    it('findByIdFull returns null for an unknown id', async () => {
      const view = await repo.findByIdFull('00000000-0000-7000-8000-deadbeef0000');
      expect(view).toBeNull();
    });

    it('projection issues NO UPDATE — the PR-1 immutability trigger is untouched', async () => {
      const id = '00000000-0000-7000-8000-0000000000f8';
      await repo.createSnapshot(baseInput({ id }));

      // Spy on the Prisma client's update/updateMany surface across the
      // delegate the projection might use (talentJobExamination only —
      // the projection touches no other model). Any write would be a
      // scope breach.
      const updateSpy = vi.spyOn(prisma.talentJobExamination, 'update');
      const updateManySpy = vi.spyOn(prisma.talentJobExamination, 'updateMany');

      try {
        await repo.findByIdFull(id);
        await repo.findByIdSummary(id);
        expect(updateSpy).not.toHaveBeenCalled();
        expect(updateManySpy).not.toHaveBeenCalled();
      } finally {
        updateSpy.mockRestore();
        updateManySpy.mockRestore();
      }
    });
  },
);
