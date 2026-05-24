import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AramoError, type AramoLogger } from '@aramo/common';
import { EvidenceRepository } from '@aramo/evidence';
import { ExaminationRepository } from '@aramo/examination';

import type { CreateSubmittalInput } from '../lib/dto/talent-submittal-record.view.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SubmittalRepository } from '../lib/submittal.repository.js';

// M4 PR-9 §4.5 — SubmittalRepository constructor now takes an
// AramoLogger as 4th arg. Tests inject a no-op mock to satisfy the
// shape without coupling assertions to log output.
function makeMockLogger(): AramoLogger {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as AramoLogger;
}

// M4 PR-3 §4.11 — unit spec for SubmittalRepository.
//
// Mocks EvidenceRepository.buildPackage + Prisma create. Asserts the
// orchestration:
//   1. createSubmittal calls buildPackage with the input forwarded
//      (with id=generated evidence_package_id).
//   2. createSubmittal writes a TalentSubmittalRecord row with
//      state='draft', pinned_examination_id from input.examination_id,
//      evidence_package_id from step 1.
//   3. justification + failed_criterion_acknowledgments persist
//      verbatim when provided.
//   4. When buildPackage throws (Stretch / NOT_FOUND), no submittal row
//      is written.

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TALENT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const JOB_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const EXAM_ID = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const RECRUITER_ID = '00000000-0000-7000-8000-000000000bb1';

function makeInput(overrides: Partial<CreateSubmittalInput> = {}): CreateSubmittalInput {
  return {
    tenant_id: TENANT_A,
    talent_id: TALENT_A,
    job_id: JOB_ID,
    examination_id: EXAM_ID,
    created_by: RECRUITER_ID,
    talent_identity: {
      full_name: 'Sample Talent',
      preferred_name: 'Sam',
      location: 'Remote (US)',
    },
    contact_summary: { contact_available: true, channels_verified: ['email'] },
    capability_summary_overrides: {
      key_work_history: [
        { employer_name: 'Acme', role_title: 'Senior Engineer', start_date: '2021-01-01' },
      ],
    },
    recruiter_contribution: {
      conversation_summary: { recruiter_summary: 'Discussed role.' },
      talent_confirmed: { spoken_to_recruiter: true },
    },
    ...overrides,
  };
}

interface MockPrisma {
  talentSubmittalRecord: {
    create: ReturnType<typeof vi.fn>;
    findFirst?: ReturnType<typeof vi.fn>;
    update?: ReturnType<typeof vi.fn>;
  };
}

const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f00';

describe('SubmittalRepository.createSubmittal (unit)', () => {
  let create: ReturnType<typeof vi.fn>;
  let buildPackage: ReturnType<typeof vi.fn>;
  let repo: SubmittalRepository;

  beforeEach(() => {
    create = vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      created_at: new Date('2026-05-23T12:00:00Z'),
      confirmed_at: null,
      justification: data['justification'] ?? null,
      failed_criterion_acknowledgments: data['failed_criterion_acknowledgments'] ?? null,
    }));
    buildPackage = vi.fn().mockResolvedValue({ id: 'package-id-1' });
    const mockPrisma: MockPrisma = { talentSubmittalRecord: { create } };
    const mockEvidence = { buildPackage } as unknown as EvidenceRepository;
    // M4 PR-4 §4.5 — repository now takes ExaminationRepository as third
    // ctor param; createSubmittal does not use it, so an empty mock is
    // safe for these create-flow tests.
    const mockExamination = {} as unknown as ExaminationRepository;
    repo = new SubmittalRepository(
      mockPrisma as unknown as PrismaService,
      mockEvidence,
      mockExamination,
      makeMockLogger(),
    );
  });

  it('1. successful create forwards input to buildPackage and writes draft submittal', async () => {
    const view = await repo.createSubmittal(makeInput());
    expect(buildPackage).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(view.state).toBe('draft');
    expect(view.tenant_id).toBe(TENANT_A);
    expect(view.talent_id).toBe(TALENT_A);
    expect(view.pinned_examination_id).toBe(EXAM_ID);
    expect(view.confirmed_at).toBeNull();
  });

  it('2. evidence_package_id flows from generated UUID into submittal row', async () => {
    const view = await repo.createSubmittal(makeInput());
    const buildPackageArg = buildPackage.mock.calls[0]?.[0] as { id: string };
    expect(buildPackageArg.id).toBe(view.evidence_package_id);
  });

  it('3. justification + failed_criterion_acknowledgments persist verbatim', async () => {
    const fca = [
      {
        criterion: 'rate_within_band',
        field_path: 'talent_rate.min_rate',
        observed_value: '150',
        expected_threshold: '<=180',
        acknowledged: true,
      },
    ];
    const view = await repo.createSubmittal(
      makeInput({
        justification: 'Strong soft skills despite missing certification',
        failed_criterion_acknowledgments: fca,
      }),
    );
    expect(view.justification).toBe('Strong soft skills despite missing certification');
    expect(view.failed_criterion_acknowledgments).toEqual(fca);
  });

  it('4. when buildPackage throws, no submittal row is written', async () => {
    buildPackage.mockRejectedValue(new Error('SUBMITTAL_STRETCH_BLOCKED'));
    await expect(repo.createSubmittal(makeInput())).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it('5. justification absent → persisted as null', async () => {
    const view = await repo.createSubmittal(makeInput());
    expect(view.justification).toBeNull();
    expect(view.failed_criterion_acknowledgments).toBeNull();
  });
});

// =============================================================================
// M4 PR-4 §4.10 — confirmSubmittal unit tests (8 new)
// =============================================================================

const SUBMITTAL_ID = '99990000-0000-7000-8000-000000000001';

function buildConfirmMocks(opts: {
  findFirstResult: unknown;
  findByIdFullResult: unknown;
  findLatestResult: unknown;
}): {
  repo: SubmittalRepository;
  update: ReturnType<typeof vi.fn>;
} {
  const findFirst = vi.fn().mockResolvedValue(opts.findFirstResult);
  const update = vi.fn().mockImplementation(({ data, where }: {
    data: Record<string, unknown>;
    where: Record<string, unknown>;
  }) => ({
    ...(opts.findFirstResult as Record<string, unknown>),
    ...data,
    id: (where['id'] as string) ?? SUBMITTAL_ID,
  }));
  const mockPrisma: MockPrisma = {
    talentSubmittalRecord: {
      create: vi.fn(),
      findFirst,
      update,
    },
  };
  const mockEvidence = {} as unknown as EvidenceRepository;
  const mockExamination = {
    findByIdFull: vi.fn().mockResolvedValue(opts.findByIdFullResult),
    findLatestByTenantTalentJob: vi.fn().mockResolvedValue(opts.findLatestResult),
  } as unknown as ExaminationRepository;
  const repo = new SubmittalRepository(
    mockPrisma as unknown as PrismaService,
    mockEvidence,
    mockExamination,
    makeMockLogger(),
  );
  return { repo, update };
}

const ENT_EXAM_ID = '11110000-0000-7000-8000-0000000e0001';

function makeStoredDraft(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: SUBMITTAL_ID,
    tenant_id: TENANT_A,
    talent_id: TALENT_A,
    job_id: JOB_ID,
    evidence_package_id: '99990000-0000-7000-8000-000000000002',
    pinned_examination_id: ENT_EXAM_ID,
    state: 'draft',
    created_by: RECRUITER_ID,
    justification: null,
    failed_criterion_acknowledgments: null,
    created_at: new Date('2026-05-23T12:00:00Z'),
    confirmed_at: null,
    ...overrides,
  };
}

function makeFullView(overrides: Record<string, unknown> = {}): unknown {
  return {
    examination_id: ENT_EXAM_ID,
    talent_id: TALENT_A,
    job_id: JOB_ID,
    tier: 'ENTRUSTABLE',
    rank_ordinal: 1,
    why_matched_sentence: 'matches',
    top_skills: [],
    confidence_summary: {
      evidence_strength: { level: 'high', basis: 'x' },
      data_completeness: { level: 'high', basis: 'x' },
      constraint_confidence: { level: 'high', basis: 'x' },
    },
    freshness_indicator: { profile_age_days: 1 },
    computed_at: new Date('2026-05-23T09:00:00Z'),
    expanded_reasoning: [],
    skill_match: { matched_count: 1, missing_count: 0, per_skill: [] },
    experience_match: { years: 5 },
    constraint_checks: {},
    strengths: [],
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

describe('SubmittalRepository.confirmSubmittal (unit)', () => {
  it('1. successful confirm: state transitions to submitted, confirmed_at set', async () => {
    const { repo, update } = buildConfirmMocks({
      findFirstResult: makeStoredDraft(),
      findByIdFullResult: makeFullView(),
      findLatestResult: { id: ENT_EXAM_ID },
    });
    const view = await repo.confirmSubmittal({
      tenant_id: TENANT_A,
      submittal_id: SUBMITTAL_ID,
      attestations: {
        talent_evidence_reviewed: true,
        constraints_reviewed: true,
        submittal_risk_acknowledged: true,
      },
      requestId: REQUEST_ID,
    });
    expect(view.state).toBe('submitted');
    expect(update).toHaveBeenCalledTimes(1);
    const updateArg = update.mock.calls[0]?.[0] as {
      data: { state: string; confirmed_at: Date };
      where: { id: string; tenant_id: string };
    };
    expect(updateArg.data.state).toBe('submitted');
    expect(updateArg.data.confirmed_at).toBeInstanceOf(Date);
    expect(updateArg.where.id).toBe(SUBMITTAL_ID);
    expect(updateArg.where.tenant_id).toBe(TENANT_A);
  });

  it('2. findById null → NOT_FOUND 404', async () => {
    const { repo, update } = buildConfirmMocks({
      findFirstResult: null,
      findByIdFullResult: null,
      findLatestResult: null,
    });
    try {
      await repo.confirmSubmittal({
        tenant_id: TENANT_A,
        submittal_id: SUBMITTAL_ID,
        attestations: {
          talent_evidence_reviewed: true,
          constraints_reviewed: true,
          submittal_risk_acknowledged: true,
        },
        requestId: REQUEST_ID,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AramoError);
      expect((err as AramoError).code).toBe('NOT_FOUND');
      expect((err as AramoError).statusCode).toBe(404);
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('3. state already "submitted" → SUBMITTAL_ALREADY_CONFIRMED 409', async () => {
    const { repo, update } = buildConfirmMocks({
      findFirstResult: makeStoredDraft({ state: 'submitted' }),
      findByIdFullResult: makeFullView(),
      findLatestResult: { id: ENT_EXAM_ID },
    });
    try {
      await repo.confirmSubmittal({
        tenant_id: TENANT_A,
        submittal_id: SUBMITTAL_ID,
        attestations: {
          talent_evidence_reviewed: true,
          constraints_reviewed: true,
          submittal_risk_acknowledged: true,
        },
        requestId: REQUEST_ID,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AramoError).code).toBe('SUBMITTAL_ALREADY_CONFIRMED');
      expect((err as AramoError).statusCode).toBe(409);
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('4. findByIdFull null → EXAMINATION_PINNED_OUTDATED 409', async () => {
    const { repo, update } = buildConfirmMocks({
      findFirstResult: makeStoredDraft(),
      findByIdFullResult: null,
      findLatestResult: null,
    });
    try {
      await repo.confirmSubmittal({
        tenant_id: TENANT_A,
        submittal_id: SUBMITTAL_ID,
        attestations: {
          talent_evidence_reviewed: true,
          constraints_reviewed: true,
          submittal_risk_acknowledged: true,
        },
        requestId: REQUEST_ID,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AramoError).code).toBe('EXAMINATION_PINNED_OUTDATED');
      expect((err as AramoError).statusCode).toBe(409);
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('5. lifecycle="archived" → EXAMINATION_PINNED_OUTDATED 409', async () => {
    const { repo, update } = buildConfirmMocks({
      findFirstResult: makeStoredDraft(),
      findByIdFullResult: makeFullView({ lifecycle_state: 'archived' }),
      findLatestResult: null,
    });
    try {
      await repo.confirmSubmittal({
        tenant_id: TENANT_A,
        submittal_id: SUBMITTAL_ID,
        attestations: {
          talent_evidence_reviewed: true,
          constraints_reviewed: true,
          submittal_risk_acknowledged: true,
        },
        requestId: REQUEST_ID,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AramoError).code).toBe('EXAMINATION_PINNED_OUTDATED');
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('6. tier="STRETCH" → SUBMITTAL_STRETCH_BLOCKED 422', async () => {
    const { repo, update } = buildConfirmMocks({
      findFirstResult: makeStoredDraft(),
      findByIdFullResult: makeFullView({ tier: 'STRETCH' }),
      findLatestResult: { id: ENT_EXAM_ID },
    });
    try {
      await repo.confirmSubmittal({
        tenant_id: TENANT_A,
        submittal_id: SUBMITTAL_ID,
        attestations: {
          talent_evidence_reviewed: true,
          constraints_reviewed: true,
          submittal_risk_acknowledged: true,
        },
        requestId: REQUEST_ID,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AramoError).code).toBe('SUBMITTAL_STRETCH_BLOCKED');
      expect((err as AramoError).statusCode).toBe(422);
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('7. findLatest id mismatch → EXAMINATION_PINNED_OUTDATED 409', async () => {
    const { repo, update } = buildConfirmMocks({
      findFirstResult: makeStoredDraft(),
      findByIdFullResult: makeFullView(),
      findLatestResult: { id: 'ffff0000-0000-7000-8000-ffffffffffff' },
    });
    try {
      await repo.confirmSubmittal({
        tenant_id: TENANT_A,
        submittal_id: SUBMITTAL_ID,
        attestations: {
          talent_evidence_reviewed: true,
          constraints_reviewed: true,
          submittal_risk_acknowledged: true,
        },
        requestId: REQUEST_ID,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AramoError).code).toBe('EXAMINATION_PINNED_OUTDATED');
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('8. WORTH_CONSIDERING missing justification → JUSTIFICATION_REQUIRED 422', async () => {
    const wcExamId = '22220000-0000-7000-8000-0000000c0001';
    const { repo, update } = buildConfirmMocks({
      findFirstResult: makeStoredDraft({ pinned_examination_id: wcExamId, justification: null }),
      findByIdFullResult: makeFullView({ tier: 'WORTH_CONSIDERING' }),
      findLatestResult: { id: wcExamId },
    });
    try {
      await repo.confirmSubmittal({
        tenant_id: TENANT_A,
        submittal_id: SUBMITTAL_ID,
        attestations: {
          talent_evidence_reviewed: true,
          constraints_reviewed: true,
          submittal_risk_acknowledged: true,
        },
        requestId: REQUEST_ID,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AramoError).code).toBe('JUSTIFICATION_REQUIRED');
      expect((err as AramoError).statusCode).toBe(422);
    }
    expect(update).not.toHaveBeenCalled();
  });
});

// =============================================================================
// M4 PR-7 §4.10 — revokeSubmittal unit tests (4 new)
// =============================================================================

function buildRevokeMocks(opts: {
  findFirstResult: unknown;
}): {
  repo: SubmittalRepository;
  update: ReturnType<typeof vi.fn>;
} {
  const findFirst = vi.fn().mockResolvedValue(opts.findFirstResult);
  const update = vi.fn().mockImplementation(({ data, where }: {
    data: Record<string, unknown>;
    where: Record<string, unknown>;
  }) => ({
    ...(opts.findFirstResult as Record<string, unknown>),
    ...data,
    id: (where['id'] as string) ?? SUBMITTAL_ID,
  }));
  const mockPrisma: MockPrisma = {
    talentSubmittalRecord: {
      create: vi.fn(),
      findFirst,
      update,
    },
  };
  const mockEvidence = {} as unknown as EvidenceRepository;
  const mockExamination = {} as unknown as ExaminationRepository;
  const repo = new SubmittalRepository(
    mockPrisma as unknown as PrismaService,
    mockEvidence,
    mockExamination,
    makeMockLogger(),
  );
  return { repo, update };
}

const REVOKER_ID = '00000000-0000-7000-8000-000000000bb2';
const REVOKE_JUSTIFICATION = 'Position frozen by hiring manager; revoking.';

describe('SubmittalRepository.revokeSubmittal (unit)', () => {
  it('1. successful revoke: state transitions to revoked, revoke metadata stamped', async () => {
    const { repo, update } = buildRevokeMocks({
      findFirstResult: makeStoredDraft({
        state: 'submitted',
        confirmed_at: new Date('2026-05-23T13:00:00Z'),
      }),
    });
    const view = await repo.revokeSubmittal({
      tenant_id: TENANT_A,
      submittal_id: SUBMITTAL_ID,
      revoked_by: REVOKER_ID,
      revocation_justification: REVOKE_JUSTIFICATION,
      requestId: REQUEST_ID,
    });
    expect(view.state).toBe('revoked');
    expect(update).toHaveBeenCalledTimes(1);
    const updateArg = update.mock.calls[0]?.[0] as {
      data: {
        state: string;
        revoked_at: Date;
        revoked_by: string;
        revocation_justification: string;
      };
      where: { id: string; tenant_id: string };
    };
    expect(updateArg.data.state).toBe('revoked');
    expect(updateArg.data.revoked_at).toBeInstanceOf(Date);
    expect(updateArg.data.revoked_by).toBe(REVOKER_ID);
    expect(updateArg.data.revocation_justification).toBe(REVOKE_JUSTIFICATION);
    expect(updateArg.where.id).toBe(SUBMITTAL_ID);
    expect(updateArg.where.tenant_id).toBe(TENANT_A);
  });

  it('2. findById null → NOT_FOUND 404; no update called', async () => {
    const { repo, update } = buildRevokeMocks({
      findFirstResult: null,
    });
    try {
      await repo.revokeSubmittal({
        tenant_id: TENANT_A,
        submittal_id: SUBMITTAL_ID,
        revoked_by: REVOKER_ID,
        revocation_justification: REVOKE_JUSTIFICATION,
        requestId: REQUEST_ID,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AramoError);
      expect((err as AramoError).code).toBe('NOT_FOUND');
      expect((err as AramoError).statusCode).toBe(404);
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('3. state=draft → REVOKE_NOT_ALLOWED 422 with current_state detail; no update called', async () => {
    const { repo, update } = buildRevokeMocks({
      findFirstResult: makeStoredDraft({ state: 'draft' }),
    });
    try {
      await repo.revokeSubmittal({
        tenant_id: TENANT_A,
        submittal_id: SUBMITTAL_ID,
        revoked_by: REVOKER_ID,
        revocation_justification: REVOKE_JUSTIFICATION,
        requestId: REQUEST_ID,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AramoError).code).toBe('REVOKE_NOT_ALLOWED');
      expect((err as AramoError).statusCode).toBe(422);
      const ctx = (err as AramoError).context;
      expect(ctx.details).toMatchObject({
        submittal_id: SUBMITTAL_ID,
        current_state: 'draft',
      });
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('4. state=revoked → REVOKE_NOT_ALLOWED 422 with current_state=revoked; no update called', async () => {
    const { repo, update } = buildRevokeMocks({
      findFirstResult: makeStoredDraft({
        state: 'revoked',
        confirmed_at: new Date('2026-05-23T13:00:00Z'),
        revoked_at: new Date('2026-05-23T15:00:00Z'),
        revoked_by: REVOKER_ID,
        revocation_justification: 'already revoked',
      }),
    });
    try {
      await repo.revokeSubmittal({
        tenant_id: TENANT_A,
        submittal_id: SUBMITTAL_ID,
        revoked_by: REVOKER_ID,
        revocation_justification: REVOKE_JUSTIFICATION,
        requestId: REQUEST_ID,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AramoError).code).toBe('REVOKE_NOT_ALLOWED');
      expect((err as AramoError).statusCode).toBe(422);
      const ctx = (err as AramoError).context;
      expect(ctx.details).toMatchObject({
        submittal_id: SUBMITTAL_ID,
        current_state: 'revoked',
      });
    }
    expect(update).not.toHaveBeenCalled();
  });
});
