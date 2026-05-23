import { describe, expect, it, vi } from 'vitest';

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
