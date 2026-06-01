import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AramoError, makeMockLogger } from '@aramo/common';
import { EvidenceRepository } from '@aramo/evidence';
import { ExaminationRepository } from '@aramo/examination';

import type { CreateSubmittalInput } from '../lib/dto/talent-submittal-record.view.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SubmittalRepository } from '../lib/submittal.repository.js';
import { TalentSubmittalEventRepository } from '../lib/talent-submittal-event.repository.js';

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
  // M5 PR-8b2 §4.7 — state-changing methods use prisma.$transaction(
  // [update, talentSubmittalEvent.create]). Tests that exercise the
  // confirm/markReady/submitToAts/confirmAts/revoke paths set these
  // mocks; createSubmittal tests omit them.
  talentSubmittalEvent?: {
    create: ReturnType<typeof vi.fn>;
  };
  // M6 PR-2 §3 — in-transaction outbox emission. State-changing methods
  // now include a prisma.outboxEvent.create({...}) call as the last op
  // in the $transaction array; the mock stubs `create` so building the
  // array argument does not throw on `undefined.create`.
  outboxEvent?: {
    create: ReturnType<typeof vi.fn>;
  };
  $transaction?: ReturnType<typeof vi.fn>;
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
    // M5 PR-8b2 §4.7 + Ruling 17 — 5th DI dep TalentSubmittalEventRepository.
    // createSubmittal does NOT use it (Ruling 15: no event emission at
    // create), so an empty mock is safe for these create-flow tests.
    const mockEventRepo = {} as unknown as TalentSubmittalEventRepository;
    repo = new SubmittalRepository(
      mockPrisma as unknown as PrismaService,
      mockEvidence,
      mockExamination,
      makeMockLogger(),
      mockEventRepo,
    );
  });

  it('1. successful create forwards input to buildPackage and writes created-state submittal', async () => {
    const view = await repo.createSubmittal(makeInput());
    expect(buildPackage).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(view.state).toBe('created');
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
  const eventCreate = vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
    id: data['id'],
    tenant_id: data['tenant_id'],
    submittal_id: data['submittal_id'],
    event_type: data['event_type'],
    event_payload: data['event_payload'],
    created_at: new Date('2026-05-22T13:00:00Z'),
  }));
  // M5 PR-8b2 §4.7 — confirmSubmittal + new mainline endpoints use
  // prisma.$transaction([update, event.create]). Mock returns the
  // results array in order: [updatedRow, eventRow].
  const $transactionMock = vi.fn().mockImplementation(async (ops: Array<unknown>) => {
    // Vitest mock calls capture per-mock invocation; we synthesise the
    // result from the mock implementations the controller composed.
    // The two ops are [update(...), eventCreate(...)]; both are
    // already-resolved values from the mock factories.
    return Promise.all(ops as Array<Promise<unknown>>);
  });
  const mockPrisma: MockPrisma = {
    talentSubmittalRecord: {
      create: vi.fn(),
      findFirst,
      update,
    },
    talentSubmittalEvent: {
      create: eventCreate,
    },
    outboxEvent: {
      create: vi.fn(),
    },
    $transaction: $transactionMock,
  };
  const mockEvidence = {} as unknown as EvidenceRepository;
  const mockExamination = {
    findByIdFull: vi.fn().mockResolvedValue(opts.findByIdFullResult),
    findLatestByTenantTalentJob: vi.fn().mockResolvedValue(opts.findLatestResult),
  } as unknown as ExaminationRepository;
  const mockEventRepo = {} as unknown as TalentSubmittalEventRepository;
  const repo = new SubmittalRepository(
    mockPrisma as unknown as PrismaService,
    mockEvidence,
    mockExamination,
    makeMockLogger(),
    mockEventRepo,
  );
  return { repo, update };
}

const ENT_EXAM_ID = '11110000-0000-7000-8000-0000000e0001';

// Helper named for legacy reasons; under M5 PR-8b2 the "draft" baseline
// is the canonical 'created' lifecycle-start state. Tests pass override
// to walk further down the chain (handoff_draft, ready_for_review,
// submitted_to_ats, confirmed, revoked).
function makeStoredDraft(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: SUBMITTAL_ID,
    tenant_id: TENANT_A,
    talent_id: TALENT_A,
    job_id: JOB_ID,
    evidence_package_id: '99990000-0000-7000-8000-000000000002',
    pinned_examination_id: ENT_EXAM_ID,
    // M5 PR-8b2 rename: M4 'draft' renames to canonical 'created'
    // (lifecycle start state). The helper default produces the
    // pre-confirm baseline; tests override `state` to walk the
    // canonical chain further.
    state: 'created',
    created_by: RECRUITER_ID,
    justification: null,
    failed_criterion_acknowledgments: null,
    created_at: new Date('2026-05-23T12:00:00Z'),
    confirmed_at: null,
    revoked_at: null,
    revoked_by: null,
    revocation_justification: null,
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
  it('1. successful confirm: state transitions created -> handoff_draft (M5 PR-8b2 Ruling 12)', async () => {
    const { repo, update } = buildConfirmMocks({
      findFirstResult: makeStoredDraft(),
      findByIdFullResult: makeFullView(),
      findLatestResult: { id: ENT_EXAM_ID },
    });
    const { submittal: view } = await repo.confirmSubmittal({
      tenant_id: TENANT_A,
      submittal_id: SUBMITTAL_ID,
      attestations: {
        talent_evidence_reviewed: true,
        constraints_reviewed: true,
        submittal_risk_acknowledged: true,
      },
      event_id: '11111111-2222-7333-8444-555555555555',
      requestId: REQUEST_ID,
    });
    expect(view.state).toBe('handoff_draft');
    expect(update).toHaveBeenCalledTimes(1);
    const updateArg = update.mock.calls[0]?.[0] as {
      data: { state: string };
      where: { id: string; tenant_id: string };
    };
    expect(updateArg.data.state).toBe('handoff_draft');
    // M5 PR-8b2 Ruling 6: confirmed_at NOT populated at this transition;
    // moves to /submit-to-ats (ready_for_review -> submitted_to_ats).
    expect(updateArg.data).not.toHaveProperty('confirmed_at');
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

  it('3. state already "handoff_draft" → SUBMITTAL_ALREADY_CONFIRMED 409 (M5 PR-8b2 rename)', async () => {
    const { repo, update } = buildConfirmMocks({
      findFirstResult: makeStoredDraft({ state: 'handoff_draft' }),
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
  const eventCreate = vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
    id: data['id'],
    tenant_id: data['tenant_id'],
    submittal_id: data['submittal_id'],
    event_type: data['event_type'],
    event_payload: data['event_payload'],
    created_at: new Date('2026-05-23T15:00:00Z'),
  }));
  const $transactionMock = vi.fn().mockImplementation(async (ops: Array<unknown>) => {
    return Promise.all(ops as Array<Promise<unknown>>);
  });
  const mockPrisma: MockPrisma = {
    talentSubmittalRecord: {
      create: vi.fn(),
      findFirst,
      update,
    },
    talentSubmittalEvent: {
      create: eventCreate,
    },
    outboxEvent: {
      create: vi.fn(),
    },
    $transaction: $transactionMock,
  };
  const mockEvidence = {} as unknown as EvidenceRepository;
  const mockExamination = {} as unknown as ExaminationRepository;
  const mockEventRepo = {} as unknown as TalentSubmittalEventRepository;
  const repo = new SubmittalRepository(
    mockPrisma as unknown as PrismaService,
    mockEvidence,
    mockExamination,
    makeMockLogger(),
    mockEventRepo,
  );
  return { repo, update };
}

const REVOKER_ID = '00000000-0000-7000-8000-000000000bb2';
const REVOKE_JUSTIFICATION = 'Position frozen by hiring manager; revoking.';

describe('SubmittalRepository.revokeSubmittal (unit)', () => {
  it('1. successful revoke from submitted_to_ats: state transitions to revoked, revoke metadata stamped (M5 PR-8b2 rename)', async () => {
    const { repo, update } = buildRevokeMocks({
      findFirstResult: makeStoredDraft({
        state: 'submitted_to_ats',
        confirmed_at: new Date('2026-05-23T13:00:00Z'),
      }),
    });
    const { submittal: view } = await repo.revokeSubmittal({
      tenant_id: TENANT_A,
      submittal_id: SUBMITTAL_ID,
      revoked_by: REVOKER_ID,
      revocation_justification: REVOKE_JUSTIFICATION,
      event_id: '11111111-2222-7333-8444-666666666666',
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
        event_id: '11111111-2222-7333-8444-666666666666',
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

  it('3. state=confirmed (terminal) → REVOKE_NOT_ALLOWED 422 (M5 PR-8b2 Ruling 5)', async () => {
    // M5 PR-8b2 Q3 expansion + Ruling 5: revoke is legal from any
    // non-terminal state (`created`, `handoff_draft`,
    // `ready_for_review`, `submitted_to_ats`). It is REFUSED from the
    // 2 terminal states `confirmed` and `revoked`. M4's revoke-from-
    // draft refusal flips to a legal sibling-revoke success
    // post-rename; the new refusal target is the `confirmed` terminal
    // state (and the already-revoked case below).
    const { repo, update } = buildRevokeMocks({
      findFirstResult: makeStoredDraft({
        state: 'confirmed',
        confirmed_at: new Date('2026-05-23T13:00:00Z'),
      }),
    });
    try {
      await repo.revokeSubmittal({
        tenant_id: TENANT_A,
        submittal_id: SUBMITTAL_ID,
        revoked_by: REVOKER_ID,
        revocation_justification: REVOKE_JUSTIFICATION,
        event_id: '11111111-2222-7333-8444-666666666666',
        requestId: REQUEST_ID,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AramoError).code).toBe('REVOKE_NOT_ALLOWED');
      expect((err as AramoError).statusCode).toBe(422);
      const ctx = (err as AramoError).context;
      expect(ctx.details).toMatchObject({
        submittal_id: SUBMITTAL_ID,
        current_state: 'confirmed',
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
        event_id: '11111111-2222-7333-8444-666666666666',
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
