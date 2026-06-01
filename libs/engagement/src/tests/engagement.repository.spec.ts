import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AramoError, type AramoLogger } from '@aramo/common';
import type { ExaminationRepository } from '@aramo/examination';
import type { JobDomainRepository } from '@aramo/job-domain';
import type { TalentRepository } from '@aramo/talent';

import {
  EngagementRepository,
  type CreateEngagementInput,
  type RecordConversationStartedInput,
  type RecordResponseInput,
  type SendOutreachInput,
  type TransitionStateInput,
} from '../lib/engagement.repository.js';
import type { EngagementEventRepository } from '../lib/engagement-event.repository.js';
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

// M5 PR-1 §4.9 + M5 PR-3 §4.6 — unit spec for EngagementRepository.
//
// PR-1 surface: 4 read methods (findById, findByTenantAndId,
//   findByTenantAndTalent, findByTenantAndRequisition).
// PR-3 surface: 2 write methods (createEngagement, transitionState).
//
// Vitest mocks PrismaService.talentJobEngagement +
// .talentEngagementEvent + .$transaction. Cross-schema validator deps
// (talentRepository, jobDomainRepository, examinationRepository) are
// mocked per-test for the three-pattern validator design (Amendment
// v1.1 §2). Integration tests against real Postgres + real repositories
// live in engagement.repository.integration.spec.ts.
//
// Read-only invariant for read methods (Directive Ruling 3) is still
// asserted in this spec via the "no write method invoked across any
// read path" test — even with PR-3's createEngagement / transitionState
// added to the repository's overall surface, read methods themselves
// must remain write-free.

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const TALENT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const REQUISITION_A = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const EXAM_A = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const ENGAGEMENT_1 = '00000000-0000-7000-8000-000000000001';
const ENGAGEMENT_2 = '00000000-0000-7000-8000-000000000002';
const EVENT_1 = '00000000-0000-7000-8000-0000eeee0001';

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

function makeEventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EVENT_1,
    tenant_id: TENANT_A,
    engagement_id: ENGAGEMENT_1,
    event_type: 'state_transition',
    event_payload: { from_state: null, to_state: 'surfaced' },
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
  talentEngagementEvent: {
    create: ReturnType<typeof vi.fn>;
  };
  // M6 PR-2 §3 — in-transaction outbox emission. Each $transaction
  // array now includes a prisma.outboxEvent.create({...}) call as its
  // last element; the mock stubs `create` so building the array
  // argument does not throw on `undefined.create`. Destructured row
  // count at the call site is unchanged (the repo destructures only
  // the existing 2/3 named results).
  outboxEvent: {
    create: ReturnType<typeof vi.fn>;
  };
  // PR-A1c §4 — recordUsage helper calls prisma.$executeRaw (cross-schema
  // INSERT into metering."UsageEvent"). The unit-test mock stubs it so
  // building the $transaction array does not throw at call time; the
  // real PG-transactional guarantee is exercised by the dedicated
  // integration spec at libs/metering/src/tests/transactional-guarantee.
  $executeRaw: ReturnType<typeof vi.fn>;
  $transaction: ReturnType<typeof vi.fn>;
}

function makeMockPrisma(): MockPrismaService {
  const prisma: MockPrismaService = {
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
    talentEngagementEvent: {
      create: vi.fn(),
    },
    outboxEvent: {
      create: vi.fn(),
    },
    // PR-A1c §4 — recordUsage(this.prisma, …) is invoked inline when
    // building the $transaction array; $executeRaw returns a Promise<1>
    // by default so the construction completes without throwing.
    $executeRaw: vi.fn().mockResolvedValue(1),
    // $transaction default returns the array of (mocked) results by
    // evaluating each item — prisma's real signature accepts an array
    // of "Prisma operations" but the mock just resolves whatever the
    // test wires.
    $transaction: vi.fn(),
  };
  return prisma;
}

function makeMockTalentRepo(): TalentRepository & {
  findOverlayByTenant: ReturnType<typeof vi.fn>;
} {
  return {
    findOverlayByTenant: vi.fn(),
  } as unknown as TalentRepository & { findOverlayByTenant: ReturnType<typeof vi.fn> };
}

function makeMockJobDomainRepo(): JobDomainRepository & {
  findRequisitionById: ReturnType<typeof vi.fn>;
} {
  return {
    findRequisitionById: vi.fn(),
  } as unknown as JobDomainRepository & { findRequisitionById: ReturnType<typeof vi.fn> };
}

function makeMockExaminationRepo(): ExaminationRepository & {
  findById: ReturnType<typeof vi.fn>;
} {
  return {
    findById: vi.fn(),
  } as unknown as ExaminationRepository & { findById: ReturnType<typeof vi.fn> };
}

function makeMockEngagementEventRepo(): EngagementEventRepository {
  return {} as unknown as EngagementEventRepository;
}

describe('EngagementRepository — read surface (M5 PR-1)', () => {
  let prisma: MockPrismaService;
  let logger: ReturnType<typeof makeSpyLogger>;
  let repo: EngagementRepository;

  beforeEach(() => {
    prisma = makeMockPrisma();
    logger = makeSpyLogger();
    repo = new EngagementRepository(
      prisma as unknown as PrismaService,
      makeMockEngagementEventRepo(),
      makeMockTalentRepo(),
      makeMockJobDomainRepo(),
      makeMockExaminationRepo(),
      logger,
    );
  });

  it('exposes the 4 enumerated read methods + 2 PR-3 write methods', () => {
    expect(typeof repo.findById).toBe('function');
    expect(typeof repo.findByTenantAndId).toBe('function');
    expect(typeof repo.findByTenantAndTalent).toBe('function');
    expect(typeof repo.findByTenantAndRequisition).toBe('function');
    expect(typeof repo.createEngagement).toBe('function');
    expect(typeof repo.transitionState).toBe('function');
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

  it('no write method is invoked across any read path (read-method invariant preserved)', async () => {
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

    // Read methods alone do NOT invoke write primitives (PR-3 write
    // paths exist on the same repository but are tested separately;
    // this assertion is scoped to read-method invocation only).
    expect(prisma.talentJobEngagement.create).not.toHaveBeenCalled();
    expect(prisma.talentJobEngagement.createMany).not.toHaveBeenCalled();
    expect(prisma.talentJobEngagement.createManyAndReturn).not.toHaveBeenCalled();
    expect(prisma.talentJobEngagement.update).not.toHaveBeenCalled();
    expect(prisma.talentJobEngagement.updateMany).not.toHaveBeenCalled();
    expect(prisma.talentJobEngagement.upsert).not.toHaveBeenCalled();
    expect(prisma.talentJobEngagement.delete).not.toHaveBeenCalled();
    expect(prisma.talentJobEngagement.deleteMany).not.toHaveBeenCalled();
    expect(prisma.talentEngagementEvent.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
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

describe('EngagementRepository.createEngagement (M5 PR-3 unit)', () => {
  let prisma: MockPrismaService;
  let talentRepo: ReturnType<typeof makeMockTalentRepo>;
  let jobDomainRepo: ReturnType<typeof makeMockJobDomainRepo>;
  let examRepo: ReturnType<typeof makeMockExaminationRepo>;
  let logger: ReturnType<typeof makeSpyLogger>;
  let repo: EngagementRepository;

  const validInput: CreateEngagementInput = {
    id: ENGAGEMENT_1,
    event_id: EVENT_1,
    tenant_id: TENANT_A,
    talent_id: TALENT_A,
    requisition_id: REQUISITION_A,
    examination_id: EXAM_A,
  };

  beforeEach(() => {
    prisma = makeMockPrisma();
    talentRepo = makeMockTalentRepo();
    jobDomainRepo = makeMockJobDomainRepo();
    examRepo = makeMockExaminationRepo();
    logger = makeSpyLogger();
    repo = new EngagementRepository(
      prisma as unknown as PrismaService,
      makeMockEngagementEventRepo(),
      talentRepo,
      jobDomainRepo,
      examRepo,
      logger,
    );
  });

  function arrangeAllValid(): void {
    talentRepo.findOverlayByTenant.mockResolvedValue({
      id: 'overlay-id',
      talent_id: TALENT_A,
      tenant_id: TENANT_A,
      source_recruiter_id: null,
      source_channel: 'self_signup',
      tenant_status: 'active',
      created_at: '2026-05-25T09:00:00Z',
      updated_at: '2026-05-25T09:00:00Z',
    });
    jobDomainRepo.findRequisitionById.mockResolvedValue({
      id: REQUISITION_A,
      tenant_id: TENANT_A,
      job_id: 'job-id',
      recruiter_id: 'recruiter-id',
      state: 'active',
    });
    examRepo.findById.mockResolvedValue({ id: EXAM_A, tenant_id: TENANT_A });
    prisma.$transaction.mockResolvedValue([makeRow(), makeEventRow()]);
  }

  it('happy path — all 3 validators pass + atomic transaction succeeds', async () => {
    arrangeAllValid();
    const result = await repo.createEngagement(validInput);
    expect(result.engagement.id).toBe(ENGAGEMENT_1);
    expect(result.engagement.state).toBe('surfaced');
    expect(result.event.id).toBe(EVENT_1);
    expect(result.event.event_type).toBe('state_transition');
    expect(result.event.event_payload).toEqual({ from_state: null, to_state: 'surfaced' });

    expect(talentRepo.findOverlayByTenant).toHaveBeenCalledWith({
      talent_id: TALENT_A,
      tenant_id: TENANT_A,
    });
    expect(jobDomainRepo.findRequisitionById).toHaveBeenCalledWith(REQUISITION_A);
    expect(examRepo.findById).toHaveBeenCalledWith(EXAM_A);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    const events = logger.log.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).toContain('engagement.create_started');
    expect(events).toContain('engagement.created');
  });

  it('Pattern C refusal — talent overlay null → ENGAGEMENT_REFERENCE_NOT_FOUND 422 with field=talent_id', async () => {
    arrangeAllValid();
    talentRepo.findOverlayByTenant.mockResolvedValue(null);
    await expect(repo.createEngagement(validInput)).rejects.toMatchObject({
      code: 'ENGAGEMENT_REFERENCE_NOT_FOUND',
      statusCode: 422,
    });
    try {
      await repo.createEngagement(validInput);
    } catch (err) {
      expect(err).toBeInstanceOf(AramoError);
      const e = err as AramoError;
      expect(e.context.details?.['field']).toBe('talent_id');
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(jobDomainRepo.findRequisitionById).not.toHaveBeenCalled();
    expect(examRepo.findById).not.toHaveBeenCalled();
  });

  it('Pattern A refusal — requisition null → ENGAGEMENT_REFERENCE_NOT_FOUND 422 with field=requisition_id', async () => {
    arrangeAllValid();
    jobDomainRepo.findRequisitionById.mockResolvedValue(null);
    await expect(repo.createEngagement(validInput)).rejects.toMatchObject({
      code: 'ENGAGEMENT_REFERENCE_NOT_FOUND',
      statusCode: 422,
    });
    try {
      await repo.createEngagement(validInput);
    } catch (err) {
      const e = err as AramoError;
      expect(e.context.details?.['field']).toBe('requisition_id');
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('Pattern A refusal — requisition cross-tenant → ENGAGEMENT_REFERENCE_NOT_FOUND 422', async () => {
    arrangeAllValid();
    jobDomainRepo.findRequisitionById.mockResolvedValue({
      id: REQUISITION_A,
      tenant_id: TENANT_B,  // wrong tenant
      job_id: 'job-id',
      recruiter_id: 'recruiter-id',
      state: 'active',
    });
    await expect(repo.createEngagement(validInput)).rejects.toMatchObject({
      code: 'ENGAGEMENT_REFERENCE_NOT_FOUND',
      statusCode: 422,
    });
    try {
      await repo.createEngagement(validInput);
    } catch (err) {
      const e = err as AramoError;
      expect(e.context.details?.['field']).toBe('requisition_id');
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('Pattern B refusal — examination null → ENGAGEMENT_REFERENCE_NOT_FOUND 422 with field=examination_id', async () => {
    arrangeAllValid();
    examRepo.findById.mockResolvedValue(null);
    await expect(repo.createEngagement(validInput)).rejects.toMatchObject({
      code: 'ENGAGEMENT_REFERENCE_NOT_FOUND',
      statusCode: 422,
    });
    try {
      await repo.createEngagement(validInput);
    } catch (err) {
      const e = err as AramoError;
      expect(e.context.details?.['field']).toBe('examination_id');
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('Pattern B refusal — examination cross-tenant → ENGAGEMENT_REFERENCE_NOT_FOUND 422', async () => {
    arrangeAllValid();
    examRepo.findById.mockResolvedValue({ id: EXAM_A, tenant_id: TENANT_B });
    await expect(repo.createEngagement(validInput)).rejects.toMatchObject({
      code: 'ENGAGEMENT_REFERENCE_NOT_FOUND',
      statusCode: 422,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('Pattern B skipped — examination_id omitted → no examinationRepository.findById call', async () => {
    arrangeAllValid();
    const inputWithoutExam: CreateEngagementInput = { ...validInput, examination_id: null };
    prisma.$transaction.mockResolvedValue([
      makeRow({ examination_id: null }),
      makeEventRow(),
    ]);
    const result = await repo.createEngagement(inputWithoutExam);
    expect(result.engagement.examination_id).toBeNull();
    expect(examRepo.findById).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('atomic transaction — $transaction called with engagement.create + event.create operations', async () => {
    arrangeAllValid();
    await repo.createEngagement(validInput);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // The first argument is an array of two prisma operations
    // (engagement.create + event.create). Mocks return the operation
    // objects themselves; we assert that both create methods were
    // called to produce those operation arguments.
    expect(prisma.talentJobEngagement.create).toHaveBeenCalledTimes(1);
    expect(prisma.talentEngagementEvent.create).toHaveBeenCalledTimes(1);
  });

  it('VALIDATION_ERROR on malformed UUID input', async () => {
    arrangeAllValid();
    const badInput: CreateEngagementInput = { ...validInput, id: 'not-a-uuid' };
    await expect(repo.createEngagement(badInput)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });
    expect(talentRepo.findOverlayByTenant).not.toHaveBeenCalled();
  });
});

describe('EngagementRepository.transitionState (M5 PR-3 unit)', () => {
  let prisma: MockPrismaService;
  let logger: ReturnType<typeof makeSpyLogger>;
  let repo: EngagementRepository;

  const validInput: TransitionStateInput = {
    engagement_id: ENGAGEMENT_1,
    event_id: EVENT_1,
    tenant_id: TENANT_A,
    to_state: 'evaluated',
  };

  beforeEach(() => {
    prisma = makeMockPrisma();
    logger = makeSpyLogger();
    repo = new EngagementRepository(
      prisma as unknown as PrismaService,
      makeMockEngagementEventRepo(),
      makeMockTalentRepo(),
      makeMockJobDomainRepo(),
      makeMockExaminationRepo(),
      logger,
    );
  });

  it('happy path — surfaced → evaluated is legal; $transaction invoked', async () => {
    prisma.talentJobEngagement.findFirst.mockResolvedValue(makeRow({ state: 'surfaced' }));
    prisma.$transaction.mockResolvedValue([
      makeRow({ state: 'evaluated' }),
      makeEventRow({ event_payload: { from_state: 'surfaced', to_state: 'evaluated' } }),
    ]);
    const result = await repo.transitionState(validInput);
    expect(result.engagement.state).toBe('evaluated');
    expect(result.event.event_payload).toEqual({
      from_state: 'surfaced',
      to_state: 'evaluated',
    });
    expect(prisma.talentJobEngagement.update).toHaveBeenCalledWith({
      where: { id: ENGAGEMENT_1 },
      data: { state: 'evaluated' },
    });
    expect(prisma.talentEngagementEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('engagement-not-found → NOT_FOUND 404; no $transaction', async () => {
    prisma.talentJobEngagement.findFirst.mockResolvedValue(null);
    await expect(repo.transitionState(validInput)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('illegal transition (surfaced → submitted) → ENGAGEMENT_STATE_INVALID 422; no $transaction', async () => {
    prisma.talentJobEngagement.findFirst.mockResolvedValue(makeRow({ state: 'surfaced' }));
    const badInput: TransitionStateInput = { ...validInput, to_state: 'submitted' };
    await expect(repo.transitionState(badInput)).rejects.toMatchObject({
      code: 'ENGAGEMENT_STATE_INVALID',
      statusCode: 422,
    });
    try {
      await repo.transitionState(badInput);
    } catch (err) {
      const e = err as AramoError;
      expect(e.context.details?.['from_state']).toBe('surfaced');
      expect(e.context.details?.['to_state']).toBe('submitted');
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('emits transition_started + transitioned log events on happy path', async () => {
    prisma.talentJobEngagement.findFirst.mockResolvedValue(makeRow({ state: 'surfaced' }));
    prisma.$transaction.mockResolvedValue([
      makeRow({ state: 'evaluated' }),
      makeEventRow(),
    ]);
    await repo.transitionState(validInput);
    const events = logger.log.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).toContain('engagement.transition_started');
    expect(events).toContain('engagement.transitioned');
  });

  it('emits transition_refused on illegal transition', async () => {
    prisma.talentJobEngagement.findFirst.mockResolvedValue(makeRow({ state: 'surfaced' }));
    const badInput: TransitionStateInput = { ...validInput, to_state: 'submitted' };
    await expect(repo.transitionState(badInput)).rejects.toBeInstanceOf(AramoError);
    const events = logger.log.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).toContain('engagement.transition_refused');
  });
});

// M5 PR-6 §4.16 — EngagementRepository.sendOutreach unit tests.
describe('EngagementRepository.sendOutreach (M5 PR-6 unit)', () => {
  let prisma: MockPrismaService;
  let logger: ReturnType<typeof makeSpyLogger>;
  let repo: EngagementRepository;

  const OUTREACH_EVENT_ID = '00000000-0000-7000-8000-0000eeee0010';
  const TRANSITION_EVENT_ID = '00000000-0000-7000-8000-0000eeee0011';

  const validInput: SendOutreachInput = {
    engagement_id: ENGAGEMENT_1,
    tenant_id: TENANT_A,
    outreach_event_id: OUTREACH_EVENT_ID,
    transition_event_id: TRANSITION_EVENT_ID,
    outreach_payload: {
      ai_draft_audit_record_id: '00000000-0000-7000-8000-aaaa00000a01',
      model_used: 'claude-sonnet-mock',
      input_tokens: 10,
      output_tokens: 20,
      duration_ms: 100,
      delivered_at: '2026-05-25T10:01:00.000Z',
      delivery_channel: 'email',
      delivery_id: '00000000-0000-7000-8000-dddd0d000001',
    },
  };

  beforeEach(() => {
    prisma = makeMockPrisma();
    logger = makeSpyLogger();
    repo = new EngagementRepository(
      prisma as unknown as PrismaService,
      makeMockEngagementEventRepo(),
      makeMockTalentRepo(),
      makeMockJobDomainRepo(),
      makeMockExaminationRepo(),
      logger,
    );
  });

  it('happy path — engaged → awaiting_response; $transaction invoked with 3 ops; payload preserved', async () => {
    prisma.talentJobEngagement.findFirst.mockResolvedValue(makeRow({ state: 'engaged' }));
    prisma.$transaction.mockResolvedValue([
      makeRow({ state: 'awaiting_response' }),
      makeEventRow({
        id: OUTREACH_EVENT_ID,
        event_type: 'outreach_sent',
        event_payload: validInput.outreach_payload,
      }),
      makeEventRow({
        id: TRANSITION_EVENT_ID,
        event_type: 'state_transition',
        event_payload: { from_state: 'engaged', to_state: 'awaiting_response' },
      }),
    ]);
    const result = await repo.sendOutreach(validInput);
    expect(result.engagement.state).toBe('awaiting_response');
    expect(result.outreach_event.event_type).toBe('outreach_sent');
    expect(result.outreach_event.event_payload).toEqual(validInput.outreach_payload);
    expect(result.transition_event.event_type).toBe('state_transition');
    expect(result.transition_event.event_payload).toEqual({
      from_state: 'engaged',
      to_state: 'awaiting_response',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('NOT_FOUND 404 if engagement absent; no $transaction', async () => {
    prisma.talentJobEngagement.findFirst.mockResolvedValue(null);
    await expect(repo.sendOutreach(validInput)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ENGAGEMENT_STATE_INVALID 422 if current state is not engaged (canTransition false)', async () => {
    prisma.talentJobEngagement.findFirst.mockResolvedValue(makeRow({ state: 'surfaced' }));
    await expect(repo.sendOutreach(validInput)).rejects.toMatchObject({
      code: 'ENGAGEMENT_STATE_INVALID',
      statusCode: 422,
    });
    try {
      await repo.sendOutreach(validInput);
    } catch (err) {
      const e = err as AramoError;
      expect(e.context.details?.['from_state']).toBe('surfaced');
      expect(e.context.details?.['to_state']).toBe('awaiting_response');
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('atomic transaction shape — $transaction called with engagement.update + outreach_sent event.create + state_transition event.create', async () => {
    prisma.talentJobEngagement.findFirst.mockResolvedValue(makeRow({ state: 'engaged' }));
    prisma.$transaction.mockResolvedValue([
      makeRow({ state: 'awaiting_response' }),
      makeEventRow({ event_type: 'outreach_sent', event_payload: validInput.outreach_payload }),
      makeEventRow({ event_type: 'state_transition', event_payload: { from_state: 'engaged', to_state: 'awaiting_response' } }),
    ]);
    await repo.sendOutreach(validInput);
    expect(prisma.talentJobEngagement.update).toHaveBeenCalledTimes(1);
    expect(prisma.talentJobEngagement.update).toHaveBeenCalledWith({
      where: { id: ENGAGEMENT_1 },
      data: { state: 'awaiting_response' },
    });
    expect(prisma.talentEngagementEvent.create).toHaveBeenCalledTimes(2);
  });

  it('emits outreach_started + outreach_sent log events on happy path', async () => {
    prisma.talentJobEngagement.findFirst.mockResolvedValue(makeRow({ state: 'engaged' }));
    prisma.$transaction.mockResolvedValue([
      makeRow({ state: 'awaiting_response' }),
      makeEventRow({ event_type: 'outreach_sent', event_payload: validInput.outreach_payload }),
      makeEventRow({ event_type: 'state_transition' }),
    ]);
    await repo.sendOutreach(validInput);
    const events = logger.log.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).toContain('engagement.outreach_started');
    expect(events).toContain('engagement.outreach_sent');
  });

  it('canTransition pre-check invoked — refused state emits outreach_refused log', async () => {
    prisma.talentJobEngagement.findFirst.mockResolvedValue(makeRow({ state: 'awaiting_response' }));
    await expect(repo.sendOutreach(validInput)).rejects.toBeInstanceOf(AramoError);
    const events = logger.log.mock.calls.map((c) => (c[0] as { event: string }).event);
    expect(events).toContain('engagement.outreach_refused');
  });
});

// M5 PR-7 §4.12 — EngagementRepository.recordResponse unit tests.
describe('EngagementRepository.recordResponse (M5 PR-7 unit)', () => {
  let prisma: MockPrismaService;
  let logger: ReturnType<typeof makeSpyLogger>;
  let repo: EngagementRepository;
  let eventRepoFindByTenantAndId: ReturnType<typeof vi.fn>;

  const OUTREACH_REF_ID = '00000000-0000-7000-8000-0000eeee0020';
  const RESPONSE_EVENT_ID = '00000000-0000-7000-8000-0000eeee0021';
  const TRANSITION_EVENT_ID = '00000000-0000-7000-8000-0000eeee0022';
  const RECRUITER_SUB = '00000000-0000-7000-8000-0000aabbccdd';

  const validInput: RecordResponseInput = {
    engagement_id: ENGAGEMENT_1,
    tenant_id: TENANT_A,
    response_event_id: RESPONSE_EVENT_ID,
    transition_event_id: TRANSITION_EVENT_ID,
    response_payload: {
      response_received_at: '2026-05-25T11:00:00.000Z',
      recorded_by_user_id: RECRUITER_SUB,
      outreach_event_ref_id: OUTREACH_REF_ID,
    },
  };

  function validOutreachRefRow(): Record<string, unknown> {
    return {
      id: OUTREACH_REF_ID,
      tenant_id: TENANT_A,
      engagement_id: ENGAGEMENT_1,
      event_type: 'outreach_sent',
      event_payload: { delivery_channel: 'email' },
      created_at: new Date('2026-05-25T10:01:00.000Z'),
    };
  }

  beforeEach(() => {
    prisma = makeMockPrisma();
    logger = makeSpyLogger();
    eventRepoFindByTenantAndId = vi.fn();
    const eventRepo = {
      findByTenantAndId: eventRepoFindByTenantAndId,
    } as unknown as EngagementEventRepository;
    repo = new EngagementRepository(
      prisma as unknown as PrismaService,
      eventRepo,
      makeMockTalentRepo(),
      makeMockJobDomainRepo(),
      makeMockExaminationRepo(),
      logger,
    );
  });

  it('happy path — awaiting_response → responded; $transaction invoked with 3 ops', async () => {
    prisma.talentJobEngagement.findFirst.mockResolvedValue(makeRow({ state: 'awaiting_response' }));
    eventRepoFindByTenantAndId.mockResolvedValue(validOutreachRefRow());
    prisma.$transaction.mockResolvedValue([
      makeRow({ state: 'responded' }),
      makeEventRow({
        id: RESPONSE_EVENT_ID,
        event_type: 'response_received',
        event_payload: validInput.response_payload,
      }),
      makeEventRow({
        id: TRANSITION_EVENT_ID,
        event_type: 'state_transition',
        event_payload: { from_state: 'awaiting_response', to_state: 'responded' },
      }),
    ]);
    const result = await repo.recordResponse(validInput);
    expect(result.engagement.state).toBe('responded');
    expect(result.response_event.event_type).toBe('response_received');
    expect(result.response_event.event_payload).toEqual(validInput.response_payload);
    expect(result.transition_event.event_payload).toEqual({
      from_state: 'awaiting_response',
      to_state: 'responded',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.talentJobEngagement.update).toHaveBeenCalledWith({
      where: { id: ENGAGEMENT_1 },
      data: { state: 'responded' },
    });
    expect(prisma.talentEngagementEvent.create).toHaveBeenCalledTimes(2);
  });

  it('NOT_FOUND 404 if engagement absent; no cross-event lookup; no $transaction', async () => {
    prisma.talentJobEngagement.findFirst.mockResolvedValue(null);
    await expect(repo.recordResponse(validInput)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
    expect(eventRepoFindByTenantAndId).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ENGAGEMENT_REFERENCE_NOT_FOUND 422 if cross-event ref null', async () => {
    prisma.talentJobEngagement.findFirst.mockResolvedValue(makeRow({ state: 'awaiting_response' }));
    eventRepoFindByTenantAndId.mockResolvedValue(null);
    await expect(repo.recordResponse(validInput)).rejects.toMatchObject({
      code: 'ENGAGEMENT_REFERENCE_NOT_FOUND',
      statusCode: 422,
    });
    try {
      await repo.recordResponse(validInput);
    } catch (err) {
      const e = err as AramoError;
      expect(e.context.details?.['field']).toBe('outreach_event_ref_id');
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ENGAGEMENT_REFERENCE_NOT_FOUND 422 if cross-event ref has wrong engagement_id', async () => {
    prisma.talentJobEngagement.findFirst.mockResolvedValue(makeRow({ state: 'awaiting_response' }));
    eventRepoFindByTenantAndId.mockResolvedValue({
      ...validOutreachRefRow(),
      engagement_id: '00000000-0000-7000-8000-0000eeee9999', // different engagement
    });
    await expect(repo.recordResponse(validInput)).rejects.toMatchObject({
      code: 'ENGAGEMENT_REFERENCE_NOT_FOUND',
      statusCode: 422,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ENGAGEMENT_REFERENCE_NOT_FOUND 422 if cross-event ref has wrong event_type', async () => {
    prisma.talentJobEngagement.findFirst.mockResolvedValue(makeRow({ state: 'awaiting_response' }));
    eventRepoFindByTenantAndId.mockResolvedValue({
      ...validOutreachRefRow(),
      event_type: 'state_transition', // wrong event type
    });
    await expect(repo.recordResponse(validInput)).rejects.toMatchObject({
      code: 'ENGAGEMENT_REFERENCE_NOT_FOUND',
      statusCode: 422,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ENGAGEMENT_STATE_INVALID 422 if current state is not awaiting_response (e.g., surfaced)', async () => {
    prisma.talentJobEngagement.findFirst.mockResolvedValue(makeRow({ state: 'surfaced' }));
    eventRepoFindByTenantAndId.mockResolvedValue(validOutreachRefRow());
    await expect(repo.recordResponse(validInput)).rejects.toMatchObject({
      code: 'ENGAGEMENT_STATE_INVALID',
      statusCode: 422,
    });
    try {
      await repo.recordResponse(validInput);
    } catch (err) {
      const e = err as AramoError;
      expect(e.context.details?.['from_state']).toBe('surfaced');
      expect(e.context.details?.['to_state']).toBe('responded');
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('atomic transaction shape — $transaction called with engagement.update + response_received event.create + state_transition event.create', async () => {
    prisma.talentJobEngagement.findFirst.mockResolvedValue(makeRow({ state: 'awaiting_response' }));
    eventRepoFindByTenantAndId.mockResolvedValue(validOutreachRefRow());
    prisma.$transaction.mockResolvedValue([
      makeRow({ state: 'responded' }),
      makeEventRow({ event_type: 'response_received' }),
      makeEventRow({ event_type: 'state_transition' }),
    ]);
    await repo.recordResponse(validInput);
    expect(prisma.talentJobEngagement.update).toHaveBeenCalledTimes(1);
    expect(prisma.talentEngagementEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

// M5 PR-8a §4.12 — EngagementRepository.recordConversationStarted unit tests.
//
// SMALLER than PR-7 (4 tests vs 6) because PR-8a has no cross-event
// reference validation per Ruling 3 — the
// ENGAGEMENT_REFERENCE_NOT_FOUND refusal path doesn't exist on this
// surface. Tests cover the 4 internal repository outcomes:
//   1. happy: responded → in_conversation, 3-write transaction succeeds.
//   2. NOT_FOUND: engagement absent.
//   3. ENGAGEMENT_STATE_INVALID: includes natural-key dedup
//      (in_conversation → in_conversation refused by canTransition).
//   4. atomic transaction shape.
describe('EngagementRepository.recordConversationStarted (M5 PR-8a unit)', () => {
  let prisma: MockPrismaService;
  let logger: ReturnType<typeof makeSpyLogger>;
  let repo: EngagementRepository;

  const CONVERSATION_EVENT_ID = '00000000-0000-7000-8000-0000eeee0030';
  const TRANSITION_EVENT_ID = '00000000-0000-7000-8000-0000eeee0031';
  const RECRUITER_SUB = '00000000-0000-7000-8000-0000aabbccdd';
  const CONVERSATION_STARTED_AT = '2026-05-25T12:00:00.000Z';

  const validInput: RecordConversationStartedInput = {
    engagement_id: ENGAGEMENT_1,
    tenant_id: TENANT_A,
    conversation_event_id: CONVERSATION_EVENT_ID,
    transition_event_id: TRANSITION_EVENT_ID,
    conversation_payload: {
      conversation_started_at: CONVERSATION_STARTED_AT,
      recorded_by_user_id: RECRUITER_SUB,
    },
  };

  beforeEach(() => {
    prisma = makeMockPrisma();
    logger = makeSpyLogger();
    repo = new EngagementRepository(
      prisma as unknown as PrismaService,
      makeMockEngagementEventRepo(),
      makeMockTalentRepo(),
      makeMockJobDomainRepo(),
      makeMockExaminationRepo(),
      logger,
    );
  });

  it('happy path — responded → in_conversation; $transaction invoked with 3 ops', async () => {
    prisma.talentJobEngagement.findFirst.mockResolvedValue(makeRow({ state: 'responded' }));
    prisma.$transaction.mockResolvedValue([
      makeRow({ state: 'in_conversation' }),
      makeEventRow({
        id: CONVERSATION_EVENT_ID,
        event_type: 'conversation_started',
        event_payload: validInput.conversation_payload,
      }),
      makeEventRow({
        id: TRANSITION_EVENT_ID,
        event_type: 'state_transition',
        event_payload: { from_state: 'responded', to_state: 'in_conversation' },
      }),
    ]);
    const result = await repo.recordConversationStarted(validInput);
    expect(result.engagement.state).toBe('in_conversation');
    expect(result.conversation_event.event_type).toBe('conversation_started');
    expect(result.conversation_event.event_payload).toEqual(validInput.conversation_payload);
    expect(result.transition_event.event_payload).toEqual({
      from_state: 'responded',
      to_state: 'in_conversation',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.talentJobEngagement.update).toHaveBeenCalledWith({
      where: { id: ENGAGEMENT_1 },
      data: { state: 'in_conversation' },
    });
    expect(prisma.talentEngagementEvent.create).toHaveBeenCalledTimes(2);
  });

  it('NOT_FOUND 404 if engagement absent; no $transaction', async () => {
    prisma.talentJobEngagement.findFirst.mockResolvedValue(null);
    await expect(repo.recordConversationStarted(validInput)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ENGAGEMENT_STATE_INVALID 422 if current state is not responded (e.g., awaiting_response); also covers natural-key dedup', async () => {
    // Illegal-state path: awaiting_response → in_conversation refused
    // (canTransition matrix only allows awaiting_response → responded).
    prisma.talentJobEngagement.findFirst.mockResolvedValue(makeRow({ state: 'awaiting_response' }));
    await expect(repo.recordConversationStarted(validInput)).rejects.toMatchObject({
      code: 'ENGAGEMENT_STATE_INVALID',
      statusCode: 422,
    });
    try {
      await repo.recordConversationStarted(validInput);
    } catch (err) {
      const e = err as AramoError;
      expect(e.context.details?.['from_state']).toBe('awaiting_response');
      expect(e.context.details?.['to_state']).toBe('in_conversation');
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();

    // Natural-key dedup path: in_conversation → in_conversation refused
    // (canTransition matrix has no self-loop on in_conversation).
    prisma.talentJobEngagement.findFirst.mockResolvedValue(makeRow({ state: 'in_conversation' }));
    try {
      await repo.recordConversationStarted(validInput);
    } catch (err) {
      const e = err as AramoError;
      expect(e.code).toBe('ENGAGEMENT_STATE_INVALID');
      expect(e.context.details?.['from_state']).toBe('in_conversation');
      expect(e.context.details?.['to_state']).toBe('in_conversation');
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('atomic transaction shape — $transaction called with engagement.update + conversation_started event.create + state_transition event.create (3 ops, correct order)', async () => {
    prisma.talentJobEngagement.findFirst.mockResolvedValue(makeRow({ state: 'responded' }));
    prisma.$transaction.mockResolvedValue([
      makeRow({ state: 'in_conversation' }),
      makeEventRow({ event_type: 'conversation_started' }),
      makeEventRow({ event_type: 'state_transition' }),
    ]);
    await repo.recordConversationStarted(validInput);
    expect(prisma.talentJobEngagement.update).toHaveBeenCalledTimes(1);
    expect(prisma.talentEngagementEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Verify ordering: update first, then two event.create — by reading
    // the createOrder via mock.invocationCallOrder.
    const updateOrder = prisma.talentJobEngagement.update.mock.invocationCallOrder[0] ?? 0;
    const createOrders = prisma.talentEngagementEvent.create.mock.invocationCallOrder;
    expect(createOrders.length).toBe(2);
    expect(createOrders[0]).toBeGreaterThan(updateOrder);
    expect(createOrders[1]).toBeGreaterThan(createOrders[0] ?? 0);
  });
});
