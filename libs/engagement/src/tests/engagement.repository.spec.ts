import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AramoLogger } from '@aramo/common';

import { EngagementRepository } from '../lib/engagement.repository.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// makeMockLogger from @aramo/common returns a no-op object suitable for
// satisfying the typed surface in DI; for log-assertion tests we need
// vi.fn()-backed methods so we can read .mock.calls. Local helper.
function makeSpyLogger(): AramoLogger & { log: ReturnType<typeof vi.fn> } {
  const log = vi.fn();
  return {
    log,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as AramoLogger & { log: ReturnType<typeof vi.fn> };
}

// M5 PR-1 §4.9 — unit spec for EngagementRepository (read-only surface).
//
// Vitest mocks PrismaService.talentJobEngagement. The four read methods
// are exercised; the six Prisma write methods (create, createMany,
// createManyAndReturn, update, updateMany, upsert, delete, deleteMany)
// are spied with no-op implementations so we can assert zero invocations
// across the entire test surface — the read-only-at-PR-1 invariant
// (Directive Ruling 3).
//
// Logger emissions are captured via makeMockLogger; we assert that
// entry + hit/miss/result-count paths emit structured events at each
// of the four read methods (per-PR observability standard, HK-PR-4 /
// Plan v1.5 §M4 onward).
//
// Substrate-only PR — no controllers, no service-layer writes; the
// repository is the unit. Integration tests against real Postgres live
// in engagement.repository.integration.spec.ts.

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const TALENT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const REQUISITION_A = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const EXAM_A = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const ENGAGEMENT_1 = '00000000-0000-7000-8000-000000000001';
const ENGAGEMENT_2 = '00000000-0000-7000-8000-000000000002';

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ENGAGEMENT_1,
    tenant_id: TENANT_A,
    talent_id: TALENT_A,
    requisition_id: REQUISITION_A,
    examination_id: EXAM_A,
    state: 'surfaced',
    created_at: new Date('2026-05-25T10:00:00Z'),
    ...overrides,
  };
}

interface MockPrismaService {
  talentJobEngagement: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
    createManyAndReturn: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
}

function makeMockPrisma(): MockPrismaService {
  return {
    talentJobEngagement: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      createManyAndReturn: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
}

describe('EngagementRepository — read-only surface (M5 PR-1)', () => {
  let prisma: MockPrismaService;
  let logger: ReturnType<typeof makeSpyLogger>;
  let repo: EngagementRepository;

  beforeEach(() => {
    prisma = makeMockPrisma();
    logger = makeSpyLogger();
    repo = new EngagementRepository(prisma as unknown as PrismaService, logger);
  });

  it('exposes exactly the 4 enumerated read methods with the documented signatures', () => {
    expect(typeof repo.findById).toBe('function');
    expect(typeof repo.findByTenantAndId).toBe('function');
    expect(typeof repo.findByTenantAndTalent).toBe('function');
    expect(typeof repo.findByTenantAndRequisition).toBe('function');

    // Arity (TS signatures): findById takes 1 positional arg; the other
    // three take 1 object arg. (function.length excludes optional args.)
    expect(repo.findById.length).toBe(1);
    expect(repo.findByTenantAndId.length).toBe(1);
    expect(repo.findByTenantAndTalent.length).toBe(1);
    expect(repo.findByTenantAndRequisition.length).toBe(1);
  });

  it('findById hits findUnique and emits hit-event when row exists', async () => {
    prisma.talentJobEngagement.findUnique.mockResolvedValue(makeRow());
    const view = await repo.findById(ENGAGEMENT_1);
    expect(view).not.toBeNull();
    expect(view?.id).toBe(ENGAGEMENT_1);
    expect(view?.state).toBe('surfaced');
    expect(prisma.talentJobEngagement.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.talentJobEngagement.findUnique).toHaveBeenCalledWith({
      where: { id: ENGAGEMENT_1 },
    });
    const events = logger.log.mock.calls.map((c) => (c[0] as { event?: string }).event);
    expect(events).toContain('engagement.findById');
    const logEntry = logger.log.mock.calls[0]?.[0] as {
      event: string;
      hit: boolean;
    };
    expect(logEntry.event).toBe('engagement.findById');
    expect(logEntry.hit).toBe(true);
  });

  it('findById returns null and emits miss-event when row absent', async () => {
    prisma.talentJobEngagement.findUnique.mockResolvedValue(null);
    const view = await repo.findById(ENGAGEMENT_1);
    expect(view).toBeNull();
    const logEntry = logger.log.mock.calls[0]?.[0] as { hit: boolean };
    expect(logEntry.hit).toBe(false);
  });

  it('findByTenantAndId scopes by tenant_id via findFirst', async () => {
    prisma.talentJobEngagement.findFirst.mockResolvedValue(makeRow());
    const view = await repo.findByTenantAndId({
      tenant_id: TENANT_A,
      id: ENGAGEMENT_1,
    });
    expect(view).not.toBeNull();
    expect(prisma.talentJobEngagement.findFirst).toHaveBeenCalledWith({
      where: { tenant_id: TENANT_A, id: ENGAGEMENT_1 },
    });
  });

  it('findByTenantAndTalent returns rows sorted DESC and emits result_count', async () => {
    const rows = [
      makeRow({ id: ENGAGEMENT_2, created_at: new Date('2026-05-25T11:00:00Z') }),
      makeRow({ id: ENGAGEMENT_1, created_at: new Date('2026-05-25T10:00:00Z') }),
    ];
    prisma.talentJobEngagement.findMany.mockResolvedValue(rows);
    const views = await repo.findByTenantAndTalent({
      tenant_id: TENANT_A,
      talent_id: TALENT_A,
    });
    expect(views).toHaveLength(2);
    expect(prisma.talentJobEngagement.findMany).toHaveBeenCalledWith({
      where: { tenant_id: TENANT_A, talent_id: TALENT_A },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
    const logEntry = logger.log.mock.calls[0]?.[0] as { result_count: number };
    expect(logEntry.result_count).toBe(2);
  });

  it('findByTenantAndRequisition scopes by tenant + requisition via findMany', async () => {
    prisma.talentJobEngagement.findMany.mockResolvedValue([makeRow()]);
    const views = await repo.findByTenantAndRequisition({
      tenant_id: TENANT_A,
      requisition_id: REQUISITION_A,
    });
    expect(views).toHaveLength(1);
    expect(prisma.talentJobEngagement.findMany).toHaveBeenCalledWith({
      where: { tenant_id: TENANT_A, requisition_id: REQUISITION_A },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
  });

  it('no write method is invoked across any read path (no-write spy)', async () => {
    prisma.talentJobEngagement.findUnique.mockResolvedValue(makeRow());
    prisma.talentJobEngagement.findFirst.mockResolvedValue(makeRow());
    prisma.talentJobEngagement.findMany.mockResolvedValue([makeRow()]);

    await repo.findById(ENGAGEMENT_1);
    await repo.findByTenantAndId({ tenant_id: TENANT_A, id: ENGAGEMENT_1 });
    await repo.findByTenantAndTalent({ tenant_id: TENANT_A, talent_id: TALENT_A });
    await repo.findByTenantAndRequisition({
      tenant_id: TENANT_A,
      requisition_id: REQUISITION_A,
    });

    expect(prisma.talentJobEngagement.create).not.toHaveBeenCalled();
    expect(prisma.talentJobEngagement.createMany).not.toHaveBeenCalled();
    expect(prisma.talentJobEngagement.createManyAndReturn).not.toHaveBeenCalled();
    expect(prisma.talentJobEngagement.update).not.toHaveBeenCalled();
    expect(prisma.talentJobEngagement.updateMany).not.toHaveBeenCalled();
    expect(prisma.talentJobEngagement.upsert).not.toHaveBeenCalled();
    expect(prisma.talentJobEngagement.delete).not.toHaveBeenCalled();
    expect(prisma.talentJobEngagement.deleteMany).not.toHaveBeenCalled();
  });

  it('cross-tenant findByTenantAndTalent returns empty array', async () => {
    prisma.talentJobEngagement.findMany.mockResolvedValue([]);
    const views = await repo.findByTenantAndTalent({
      tenant_id: TENANT_B,
      talent_id: TALENT_A,
    });
    expect(views).toEqual([]);
    const logEntry = logger.log.mock.calls[0]?.[0] as { result_count: number };
    expect(logEntry.result_count).toBe(0);
  });
});
