import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AramoLogger } from '@aramo/common';

import { TalentSubmittalEventRepository } from '../lib/talent-submittal-event.repository.js';
import type { AppendSubmittalEventInput } from '../lib/dto/append-submittal-event.input.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// M5 PR-8b1 §4.14 — unit spec for TalentSubmittalEventRepository.
//
// Mirrors M5 PR-2 engagement-event.repository.spec.ts shape:
// 5 methods exercised, append-only invariants asserted via spy
// confirmation that no write primitive other than `create` is invoked.

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const SUBMITTAL_A = '33333333-3333-7333-8333-333333333333';
const EVENT_1 = '00000000-0000-7000-8000-000000000001';

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EVENT_1,
    tenant_id: TENANT_A,
    submittal_id: SUBMITTAL_A,
    event_type: 'state_transition',
    event_payload: { from: 'draft', to: 'submitted' },
    created_at: new Date('2026-05-26T14:00:00Z'),
    ...overrides,
  };
}

function makeSpyLogger(): AramoLogger & { log: ReturnType<typeof vi.fn> } {
  const log = vi.fn();
  return {
    log,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as AramoLogger & { log: ReturnType<typeof vi.fn> };
}

interface MockPrisma {
  talentSubmittalEvent: {
    create: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
    createManyAndReturn: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
}

function makeMockPrisma(): MockPrisma {
  return {
    talentSubmittalEvent: {
      create: vi.fn(),
      createMany: vi.fn(),
      createManyAndReturn: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
}

describe('TalentSubmittalEventRepository (M5 PR-8b1 unit)', () => {
  let prisma: MockPrisma;
  let logger: ReturnType<typeof makeSpyLogger>;
  let repo: TalentSubmittalEventRepository;

  beforeEach(() => {
    prisma = makeMockPrisma();
    logger = makeSpyLogger();
    repo = new TalentSubmittalEventRepository(prisma as unknown as PrismaService, logger);
  });

  it('exposes exactly the 5 enumerated methods', () => {
    expect(typeof repo.appendEvent).toBe('function');
    expect(typeof repo.findById).toBe('function');
    expect(typeof repo.findBySubmittalId).toBe('function');
    expect(typeof repo.findByTenantAndSubmittalId).toBe('function');
    expect(typeof repo.findByTenantAndId).toBe('function');
  });

  describe('appendEvent', () => {
    const input: AppendSubmittalEventInput = {
      id: EVENT_1,
      tenant_id: TENANT_A,
      submittal_id: SUBMITTAL_A,
      event_type: 'state_transition',
      event_payload: { from: 'draft', to: 'submitted' },
    };

    it('calls prisma.talentSubmittalEvent.create exactly once', async () => {
      prisma.talentSubmittalEvent.create.mockResolvedValue(makeRow());
      await repo.appendEvent(input);
      expect(prisma.talentSubmittalEvent.create).toHaveBeenCalledTimes(1);
      expect(prisma.talentSubmittalEvent.create).toHaveBeenCalledWith({
        data: {
          id: input.id,
          tenant_id: input.tenant_id,
          submittal_id: input.submittal_id,
          event_type: input.event_type,
          event_payload: input.event_payload,
        },
      });
    });

    it('returns projected view with all 6 fields', async () => {
      prisma.talentSubmittalEvent.create.mockResolvedValue(makeRow());
      const view = await repo.appendEvent(input);
      expect(view.id).toBe(EVENT_1);
      expect(view.tenant_id).toBe(TENANT_A);
      expect(view.submittal_id).toBe(SUBMITTAL_A);
      expect(view.event_type).toBe('state_transition');
      expect(view.event_payload).toEqual({ from: 'draft', to: 'submitted' });
      expect(view.created_at).toBeInstanceOf(Date);
    });

    it('emits append_started and appended log events', async () => {
      prisma.talentSubmittalEvent.create.mockResolvedValue(makeRow());
      await repo.appendEvent(input);
      const events = logger.log.mock.calls.map((c) => (c[0] as { event: string }).event);
      expect(events).toContain('submittal_event.append_started');
      expect(events).toContain('submittal_event.appended');
    });

    it('never invokes update/upsert/delete primitives', async () => {
      prisma.talentSubmittalEvent.create.mockResolvedValue(makeRow());
      await repo.appendEvent(input);
      expect(prisma.talentSubmittalEvent.update).not.toHaveBeenCalled();
      expect(prisma.talentSubmittalEvent.updateMany).not.toHaveBeenCalled();
      expect(prisma.talentSubmittalEvent.upsert).not.toHaveBeenCalled();
      expect(prisma.talentSubmittalEvent.delete).not.toHaveBeenCalled();
      expect(prisma.talentSubmittalEvent.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('returns view on hit; emits hit-event', async () => {
      prisma.talentSubmittalEvent.findUnique.mockResolvedValue(makeRow());
      const view = await repo.findById(EVENT_1);
      expect(view).not.toBeNull();
      expect(view?.id).toBe(EVENT_1);
      const last = logger.log.mock.calls[0]?.[0] as { event: string; hit: boolean };
      expect(last.event).toBe('submittal_event.findById');
      expect(last.hit).toBe(true);
    });

    it('returns null on miss; emits miss-event', async () => {
      prisma.talentSubmittalEvent.findUnique.mockResolvedValue(null);
      const view = await repo.findById(EVENT_1);
      expect(view).toBeNull();
      const last = logger.log.mock.calls[0]?.[0] as { hit: boolean };
      expect(last.hit).toBe(false);
    });

    it('does not invoke any write primitive', async () => {
      prisma.talentSubmittalEvent.findUnique.mockResolvedValue(makeRow());
      await repo.findById(EVENT_1);
      expect(prisma.talentSubmittalEvent.create).not.toHaveBeenCalled();
      expect(prisma.talentSubmittalEvent.update).not.toHaveBeenCalled();
      expect(prisma.talentSubmittalEvent.upsert).not.toHaveBeenCalled();
      expect(prisma.talentSubmittalEvent.delete).not.toHaveBeenCalled();
    });
  });

  describe('findBySubmittalId', () => {
    it('returns rows ordered ASC by created_at; emits result_count', async () => {
      const rows = [makeRow({ id: 'a' }), makeRow({ id: 'b' })];
      prisma.talentSubmittalEvent.findMany.mockResolvedValue(rows);
      const views = await repo.findBySubmittalId(SUBMITTAL_A);
      expect(views).toHaveLength(2);
      expect(prisma.talentSubmittalEvent.findMany).toHaveBeenCalledWith({
        where: { submittal_id: SUBMITTAL_A },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      });
      const last = logger.log.mock.calls[0]?.[0] as { result_count: number };
      expect(last.result_count).toBe(2);
    });

    it('does not invoke any write primitive', async () => {
      prisma.talentSubmittalEvent.findMany.mockResolvedValue([]);
      await repo.findBySubmittalId(SUBMITTAL_A);
      expect(prisma.talentSubmittalEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('findByTenantAndSubmittalId', () => {
    it('scopes by tenant + submittal; emits result_count', async () => {
      prisma.talentSubmittalEvent.findMany.mockResolvedValue([makeRow()]);
      const views = await repo.findByTenantAndSubmittalId({
        tenant_id: TENANT_A,
        submittal_id: SUBMITTAL_A,
      });
      expect(views).toHaveLength(1);
      expect(prisma.talentSubmittalEvent.findMany).toHaveBeenCalledWith({
        where: { tenant_id: TENANT_A, submittal_id: SUBMITTAL_A },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      });
    });
  });

  describe('findByTenantAndId (cross-schema validator slot)', () => {
    it('scopes by tenant_id via findFirst', async () => {
      prisma.talentSubmittalEvent.findFirst.mockResolvedValue(makeRow());
      const view = await repo.findByTenantAndId({ tenant_id: TENANT_A, id: EVENT_1 });
      expect(view).not.toBeNull();
      expect(prisma.talentSubmittalEvent.findFirst).toHaveBeenCalledWith({
        where: { tenant_id: TENANT_A, id: EVENT_1 },
      });
    });

    it('returns null on cross-tenant lookup', async () => {
      prisma.talentSubmittalEvent.findFirst.mockResolvedValue(null);
      const view = await repo.findByTenantAndId({ tenant_id: TENANT_B, id: EVENT_1 });
      expect(view).toBeNull();
    });
  });
});
