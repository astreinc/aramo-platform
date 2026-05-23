import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';

import { ExaminationRepository } from '../lib/examination.repository.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// M4 PR-4 §4.1 — unit spec for ExaminationRepository.findLatestByTenantTalentJob.
//
// Mocks Prisma's talentJobExamination.findFirst. Asserts:
//   (1) null when no rows match
//   (2) latest row returned when multiple snapshots exist (the order +
//       limit + filter is built; the mock receives the constructed where /
//       orderBy and the test asserts the call shape)
//   (3) lifecycle filter excludes archived (the where clause carries
//       lifecycle_state: 'active')
//
// Single-snapshot, READ-ONLY: the method calls findFirst exactly once and
// returns the row through an `as` cast at the boundary. The unit spec
// therefore exercises the call construction; behavioral round-trip (multi-
// row ordering, archived filter actually skipping rows) is exercised by
// the matching integration spec under ARAMO_RUN_INTEGRATION=1.

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TALENT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const JOB_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';

interface MockPrisma {
  talentJobExamination: { findFirst: ReturnType<typeof vi.fn> };
}

function build(findFirstResult: unknown): {
  repo: ExaminationRepository;
  findFirst: ReturnType<typeof vi.fn>;
} {
  const findFirst = vi.fn().mockResolvedValue(findFirstResult);
  const mockPrisma: MockPrisma = { talentJobExamination: { findFirst } };
  const repo = new ExaminationRepository(
    mockPrisma as unknown as PrismaService,
    undefined as never,
  );
  return { repo, findFirst };
}

describe('ExaminationRepository.findLatestByTenantTalentJob (unit)', () => {
  it('1. returns null when no rows match', async () => {
    const { repo, findFirst } = build(null);
    const result = await repo.findLatestByTenantTalentJob({
      tenant_id: TENANT_A,
      talent_id: TALENT_A,
      job_id: JOB_ID,
    });
    expect(result).toBeNull();
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('2. returns the latest active row when one matches (order = computed_at DESC, id DESC)', async () => {
    const latestRow = {
      id: 'aaaa0000-0000-7000-8000-0000000000ff',
      tenant_id: TENANT_A,
      talent_id: TALENT_A,
      job_id: JOB_ID,
      lifecycle_state: 'active',
      computed_at: new Date('2026-05-22T10:00:00Z'),
    };
    const { repo, findFirst } = build(latestRow);
    const result = await repo.findLatestByTenantTalentJob({
      tenant_id: TENANT_A,
      talent_id: TALENT_A,
      job_id: JOB_ID,
    });
    expect(result).not.toBeNull();
    expect(result?.id).toBe(latestRow.id);
    // Assert the call construction: orderBy is the directive-mandated
    // [{ computed_at: 'desc' }, { id: 'desc' }] tuple.
    const callArg = findFirst.mock.calls[0]?.[0] as {
      orderBy: Array<Record<string, string>>;
    };
    expect(callArg.orderBy).toEqual([
      { computed_at: 'desc' },
      { id: 'desc' },
    ]);
  });

  it('3. lifecycle filter: where clause includes lifecycle_state="active" (excludes archived / cold_storage)', async () => {
    const { repo, findFirst } = build(null);
    await repo.findLatestByTenantTalentJob({
      tenant_id: TENANT_A,
      talent_id: TALENT_A,
      job_id: JOB_ID,
    });
    const callArg = findFirst.mock.calls[0]?.[0] as {
      where: { lifecycle_state: string; tenant_id: string; talent_id: string; job_id: string };
    };
    expect(callArg.where.lifecycle_state).toBe('active');
    expect(callArg.where.tenant_id).toBe(TENANT_A);
    expect(callArg.where.talent_id).toBe(TALENT_A);
    expect(callArg.where.job_id).toBe(JOB_ID);
  });
});

// =====================================================================
// M4 PR-5 §4.11 — ExaminationRepository.createOverride + findOverride*
// unit specs. Mocks Prisma client surfaces directly so we can assert the
// write-isolation contract (NO talentJobExamination.update call from
// createOverride) and the 5-step flow's refusal paths without spinning
// up Postgres.
// =====================================================================

const EXAM_ID = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
const ANOTHER_TENANT = '22222222-2222-7222-8222-222222222222';
const RECRUITER_SUB = '00000000-0000-7000-8000-0000000000bb';
const OVERRIDE_ID = '99990000-0000-7000-8000-000000000901';

interface MockOverridePrisma {
  talentJobExamination: {
    findUnique: ReturnType<typeof vi.fn>;
    update?: ReturnType<typeof vi.fn>;
  };
  examinationOverride: {
    create: ReturnType<typeof vi.fn>;
    findFirst?: ReturnType<typeof vi.fn>;
    findMany?: ReturnType<typeof vi.fn>;
  };
}

function buildOverrideRepo(opts: {
  examination?: Record<string, unknown> | null;
  overrideRow?: Record<string, unknown>;
  overrideListRows?: ReadonlyArray<Record<string, unknown>>;
}): {
  repo: ExaminationRepository;
  mocks: MockOverridePrisma;
} {
  const tjeUpdate = vi.fn();
  const mocks: MockOverridePrisma = {
    talentJobExamination: {
      findUnique: vi.fn().mockResolvedValue(opts.examination ?? null),
      update: tjeUpdate,
    },
    examinationOverride: {
      create: vi.fn().mockResolvedValue(
        opts.overrideRow ?? {
          id: OVERRIDE_ID,
          tenant_id: TENANT_A,
          examination_id: EXAM_ID,
          override_type: 'tier',
          target_field: 'tier',
          justification: 'recruiter rationale',
          created_by: RECRUITER_SUB,
          created_at: new Date('2026-05-23T12:00:00Z'),
        },
      ),
      findFirst: vi.fn().mockResolvedValue(opts.overrideRow ?? null),
      findMany: vi.fn().mockResolvedValue(opts.overrideListRows ?? []),
    },
  };
  const repo = new ExaminationRepository(
    mocks as unknown as PrismaService,
    undefined as never,
  );
  return { repo, mocks };
}

const ACTIVE_EXAM = {
  id: EXAM_ID,
  tenant_id: TENANT_A,
  lifecycle_state: 'active',
};

describe('ExaminationRepository.createOverride (unit)', () => {
  it('1. success: writes via examinationOverride.create ONLY (no talentJobExamination.update)', async () => {
    const { repo, mocks } = buildOverrideRepo({ examination: ACTIVE_EXAM });
    const view = await repo.createOverride({
      tenant_id: TENANT_A,
      examination_id: EXAM_ID,
      override_type: 'tier',
      target_field: 'tier',
      justification: 'recruiter rationale',
      created_by: RECRUITER_SUB,
    });
    // Write-isolation contract: ExaminationOverride is written; the
    // TalentJobExamination row is NEVER updated.
    expect(mocks.examinationOverride.create).toHaveBeenCalledTimes(1);
    expect(mocks.talentJobExamination.update).not.toHaveBeenCalled();
    expect(view.examination_id).toBe(EXAM_ID);
    expect(view.override_type).toBe('tier');
    // ISO 8601 string projection at the read boundary.
    expect(typeof view.created_at).toBe('string');
  });

  it('2. NOT_FOUND when examination is missing', async () => {
    const { repo, mocks } = buildOverrideRepo({ examination: null });
    await expect(
      repo.createOverride({
        tenant_id: TENANT_A,
        examination_id: EXAM_ID,
        override_type: 'tier',
        target_field: 'tier',
        justification: 'r',
        created_by: RECRUITER_SUB,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    // Refusal path: no override write attempted.
    expect(mocks.examinationOverride.create).not.toHaveBeenCalled();
  });

  it('3. NOT_FOUND when examination is archived', async () => {
    const { repo, mocks } = buildOverrideRepo({
      examination: { ...ACTIVE_EXAM, lifecycle_state: 'archived' },
    });
    const err = await repo
      .createOverride({
        tenant_id: TENANT_A,
        examination_id: EXAM_ID,
        override_type: 'tier',
        target_field: 'tier',
        justification: 'r',
        created_by: RECRUITER_SUB,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AramoError);
    expect((err as AramoError).code).toBe('NOT_FOUND');
    expect(mocks.examinationOverride.create).not.toHaveBeenCalled();
  });

  it('4. NOT_FOUND when examination belongs to a different tenant', async () => {
    const { repo, mocks } = buildOverrideRepo({
      examination: { ...ACTIVE_EXAM, tenant_id: ANOTHER_TENANT },
    });
    await expect(
      repo.createOverride({
        tenant_id: TENANT_A,
        examination_id: EXAM_ID,
        override_type: 'tier',
        target_field: 'tier',
        justification: 'r',
        created_by: RECRUITER_SUB,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.examinationOverride.create).not.toHaveBeenCalled();
  });

  it('5. AramoError context carries requestId placeholder "override" for controller re-throw', async () => {
    const { repo } = buildOverrideRepo({ examination: null });
    const err = await repo
      .createOverride({
        tenant_id: TENANT_A,
        examination_id: EXAM_ID,
        override_type: 'tier',
        target_field: 'tier',
        justification: 'r',
        created_by: RECRUITER_SUB,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AramoError);
    expect((err as AramoError).context.requestId).toBe('override');
  });
});

describe('ExaminationRepository.findOverride* (unit)', () => {
  it('findOverrideById: tenant-scoped where filter built', async () => {
    const { repo, mocks } = buildOverrideRepo({
      overrideRow: {
        id: OVERRIDE_ID,
        tenant_id: TENANT_A,
        examination_id: EXAM_ID,
        override_type: 'tier',
        target_field: 'tier',
        justification: 'r',
        created_by: RECRUITER_SUB,
        created_at: new Date('2026-05-23T12:00:00Z'),
      },
    });
    const view = await repo.findOverrideById({ tenant_id: TENANT_A, id: OVERRIDE_ID });
    expect(view).not.toBeNull();
    expect(view?.id).toBe(OVERRIDE_ID);
    const callArg = mocks.examinationOverride.findFirst?.mock.calls[0]?.[0] as {
      where: { tenant_id: string; id: string };
    };
    expect(callArg.where.tenant_id).toBe(TENANT_A);
    expect(callArg.where.id).toBe(OVERRIDE_ID);
  });

  it('findOverridesByExaminationId: orderBy [created_at asc, id asc] + tenant-scoped where', async () => {
    const { repo, mocks } = buildOverrideRepo({
      overrideListRows: [
        {
          id: OVERRIDE_ID,
          tenant_id: TENANT_A,
          examination_id: EXAM_ID,
          override_type: 'tier',
          target_field: 'tier',
          justification: 'r',
          created_by: RECRUITER_SUB,
          created_at: new Date('2026-05-23T12:00:00Z'),
        },
      ],
    });
    const views = await repo.findOverridesByExaminationId({
      tenant_id: TENANT_A,
      examination_id: EXAM_ID,
    });
    expect(views).toHaveLength(1);
    const callArg = mocks.examinationOverride.findMany?.mock.calls[0]?.[0] as {
      where: { tenant_id: string; examination_id: string };
      orderBy: Array<Record<string, string>>;
    };
    expect(callArg.where.tenant_id).toBe(TENANT_A);
    expect(callArg.where.examination_id).toBe(EXAM_ID);
    expect(callArg.orderBy).toEqual([{ created_at: 'asc' }, { id: 'asc' }]);
  });
});
