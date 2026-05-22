import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AramoError } from '@aramo/common';
import {
  ExaminationRepository,
  type TalentJobExaminationFullView,
  type TalentJobExaminationRow,
} from '@aramo/examination';
import {
  TalentEvidenceRepository,
  type TalentRateExpectationRow,
} from '@aramo/talent-evidence';

import type { BuildPackageInput } from '../lib/dto/talent-job-evidence-package.view.js';
import { EvidenceRepository } from '../lib/evidence.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// M4 PR-2 §4.7 — unit spec for EvidenceRepository.buildPackage.
//
// Vitest mocks ExaminationRepository, TalentEvidenceRepository, and the
// Prisma client. The 8 it() blocks cover the directive's §2 Ruling 8 unit
// assertion matrix: successful build, Stretch refusal, examination-not-
// found, archived / cold_storage, validation failures, rate path
// (provided / absent).
//
// All tests pass through the real EvidenceRepository code path; only
// downstream dependencies are mocked. The Prisma create call returns the
// data echoed back as a row.

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TALENT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const JOB_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const EXAM_ID = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const PACKAGE_ID = '00000000-0000-7000-8000-000000000bb1';
const RATE_ID = '66660000-0000-7000-8000-0000rate0001';

function makeFullView(
  overrides: Partial<TalentJobExaminationFullView> = {},
): TalentJobExaminationFullView {
  return {
    examination_id: EXAM_ID,
    talent_id: TALENT_A,
    job_id: JOB_ID,
    tier: 'ENTRUSTABLE',
    rank_ordinal: 1,
    why_matched_sentence: 'Strong critical-skill coverage',
    top_skills: ['typescript', 'kubernetes'],
    confidence_summary: {
      evidence_strength: { level: 'high', basis: 'ingested' },
      data_completeness: { level: 'high', basis: 'profile-complete' },
      constraint_confidence: { level: 'high', basis: 'verified' },
    },
    freshness_indicator: { profile_age_days: 14 },
    computed_at: new Date('2026-05-22T09:00:00Z'),
    expanded_reasoning: [],
    skill_match: { matched_count: 5, missing_count: 0, per_skill: [] },
    experience_match: { years: 7, summary: 'Strong' },
    constraint_checks: {},
    strengths: ['typescript-expertise'],
    gaps: [],
    risk_flags: [],
    delta_to_entrustable: null,
    evidence_references: [],
    lifecycle_state: 'active',
    archived_at: null,
    superseded_by_examination_id: null,
    ...overrides,
  };
}

function makeRow(overrides: Partial<TalentJobExaminationRow> = {}): TalentJobExaminationRow {
  return {
    id: EXAM_ID,
    tenant_id: TENANT_A,
    talent_id: TALENT_A,
    job_id: JOB_ID,
    golden_profile_id: 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
    trigger: 'initial_match',
    tier: 'ENTRUSTABLE',
    rank_ordinal: 1,
    why_matched_sentence: 'Strong critical-skill coverage',
    match_summary: 'sample',
    expanded_reasoning: [],
    skill_match: { matched_count: 5, missing_count: 0, per_skill: [] },
    experience_match: { years: 7 },
    constraint_checks: {},
    strengths: ['typescript-expertise'],
    gaps: [],
    risk_flags: [],
    confidence_indicators: {},
    freshness_indicator: { profile_age_days: 14 },
    delta_to_entrustable: null,
    examination_version: 'v1.0',
    model_version: 'v1.0',
    taxonomy_version: 'v1.0',
    computed_at: new Date('2026-05-22T09:00:00Z'),
    lifecycle_state: 'active',
    archived_at: null,
    superseded_by_examination_id: null,
    ...overrides,
  };
}

function makeRateRow(): TalentRateExpectationRow {
  return {
    id: RATE_ID,
    talent_id: TALENT_A,
    tenant_id: TENANT_A,
    employment_type: 'W2',
    min_rate: 150,
    target_rate: 180,
    currency: 'USD',
    period: 'HOURLY',
    source: 'talent_declared',
    updated_at: new Date('2026-05-22T09:00:00Z'),
  };
}

function makeBuildInput(overrides: Partial<BuildPackageInput> = {}): BuildPackageInput {
  return {
    id: PACKAGE_ID,
    tenant_id: TENANT_A,
    talent_id: TALENT_A,
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
    },
    recruiter_contribution: {
      conversation_summary: {
        recruiter_summary: 'Discussed role and availability.',
      },
      talent_confirmed: { spoken_to_recruiter: true },
    },
    ...overrides,
  };
}

interface PrismaCreateMock {
  talentJobEvidencePackage: {
    create: ReturnType<typeof vi.fn>;
  };
}

function buildRepo(
  prismaCreate: PrismaCreateMock,
  examFindById: ReturnType<typeof vi.fn>,
  examFindByIdFull: ReturnType<typeof vi.fn>,
  rateFind: ReturnType<typeof vi.fn>,
): EvidenceRepository {
  const examRepoMock = {
    findById: examFindById,
    findByIdFull: examFindByIdFull,
  } as unknown as ExaminationRepository;
  const talentEvidenceMock = {
    findTalentRateExpectationById: rateFind,
  } as unknown as TalentEvidenceRepository;
  return new EvidenceRepository(
    prismaCreate as unknown as PrismaService,
    examRepoMock,
    talentEvidenceMock,
  );
}

describe('EvidenceRepository.buildPackage (unit)', () => {
  let create: ReturnType<typeof vi.fn>;
  let examFindById: ReturnType<typeof vi.fn>;
  let examFindByIdFull: ReturnType<typeof vi.fn>;
  let rateFind: ReturnType<typeof vi.fn>;
  let repo: EvidenceRepository;

  beforeEach(() => {
    create = vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      submittal_record_id: data['submittal_record_id'] ?? null,
      parent_package_id: data['parent_package_id'] ?? null,
      engagement_event_refs: data['engagement_event_refs'] ?? [],
      created_at: new Date('2026-05-22T10:00:00Z'),
    }));
    examFindById = vi.fn().mockResolvedValue(makeRow());
    examFindByIdFull = vi.fn().mockResolvedValue(makeFullView());
    rateFind = vi.fn();
    repo = buildRepo(
      { talentJobEvidencePackage: { create } },
      examFindById,
      examFindByIdFull,
      rateFind,
    );
  });

  it('1. successful build returns the persisted view shape', async () => {
    const view = await repo.buildPackage(makeBuildInput());
    expect(view.id).toBe(PACKAGE_ID);
    expect(view.tenant_id).toBe(TENANT_A);
    expect(view.talent_id).toBe(TALENT_A);
    expect(view.job_id).toBe(JOB_ID);
    expect(view.examination_id).toBe(EXAM_ID);
    expect(view.engagement_event_refs).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('2. Stretch tier → throws SUBMITTAL_STRETCH_BLOCKED; no prisma.create', async () => {
    examFindById.mockResolvedValue(makeRow({ tier: 'STRETCH' }));
    examFindByIdFull.mockResolvedValue(makeFullView({ tier: 'STRETCH' }));
    try {
      await repo.buildPackage(makeBuildInput());
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AramoError);
      const aramoErr = err as AramoError;
      expect(aramoErr.code).toBe('SUBMITTAL_STRETCH_BLOCKED');
      expect(aramoErr.statusCode).toBe(422);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('3. findById returns null → throws NOT_FOUND; no prisma.create', async () => {
    examFindById.mockResolvedValue(null);
    try {
      await repo.buildPackage(makeBuildInput());
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AramoError);
      expect((err as AramoError).code).toBe('NOT_FOUND');
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('4. lifecycle_state archived → throws NOT_FOUND', async () => {
    examFindById.mockResolvedValue(makeRow({ lifecycle_state: 'archived' }));
    try {
      await repo.buildPackage(makeBuildInput());
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AramoError);
      expect((err as AramoError).code).toBe('NOT_FOUND');
      expect((err as AramoError).message).toContain('archived');
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('5. lifecycle_state cold_storage → throws NOT_FOUND', async () => {
    examFindById.mockResolvedValue(makeRow({ lifecycle_state: 'cold_storage' }));
    try {
      await repo.buildPackage(makeBuildInput());
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AramoError);
      expect((err as AramoError).code).toBe('NOT_FOUND');
      expect((err as AramoError).message).toContain('cold_storage');
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('6. malformed examination_id → throws VALIDATION_ERROR', async () => {
    const input = makeBuildInput({ examination_id: 'not-a-uuid' });
    try {
      await repo.buildPackage(input);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AramoError);
      expect((err as AramoError).code).toBe('VALIDATION_ERROR');
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('7. malformed talent_id / tenant_id / job_id → throws VALIDATION_ERROR', async () => {
    const cases: ReadonlyArray<Partial<BuildPackageInput>> = [
      { talent_id: 'bad' },
      { tenant_id: 'bad' },
      { job_id: 'bad' },
    ];
    for (const overrides of cases) {
      try {
        await repo.buildPackage(makeBuildInput(overrides));
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(AramoError);
        expect((err as AramoError).code).toBe('VALIDATION_ERROR');
      }
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('8. rate path: provided id → JSONB carries rate; absent → omitted', async () => {
    // Provided rate_expectation_id — rate sub-payload composed.
    rateFind.mockResolvedValue(makeRateRow());
    const withRate = await repo.buildPackage(
      makeBuildInput({ rate_expectation_id: RATE_ID }),
    );
    const rcWithRate = withRate.recruiter_contribution as unknown as {
      talent_confirmed: { rate?: { min_rate: number; currency: string } };
    };
    expect(rcWithRate.talent_confirmed.rate).toBeDefined();
    expect(rcWithRate.talent_confirmed.rate?.min_rate).toBe(150);
    expect(rcWithRate.talent_confirmed.rate?.currency).toBe('USD');
    expect(rateFind).toHaveBeenCalledWith(RATE_ID);

    // Absent rate_expectation_id — rate sub-payload omitted.
    rateFind.mockReset();
    const noRate = await repo.buildPackage(makeBuildInput());
    const rcNoRate = noRate.recruiter_contribution as unknown as {
      talent_confirmed: { rate?: unknown };
    };
    expect(rcNoRate.talent_confirmed.rate).toBeUndefined();
    expect(rateFind).not.toHaveBeenCalled();
  });
});
