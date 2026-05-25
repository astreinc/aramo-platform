import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AramoLogger } from '@aramo/common';

import {
  EngagementEventRepository,
  type AppendEventInput,
} from '../lib/engagement-event.repository.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// M5 PR-2 §4.11 — unit spec for EngagementEventRepository.
//
// 5 methods exercised: appendEvent (sole write) + 4 read methods.
// Spies confirm:
//   - appendEvent calls prisma.talentEngagementEvent.create exactly once,
//     never update/upsert/delete (architectural append-only invariant;
//     DB-trigger reinforces — see schema-invariant integration spec).
//   - Each read method invokes only the appropriate read primitive
//     (findUnique/findFirst/findMany); no write methods invoked.
//   - Logger structured events emitted at entry/success/refusal/hit/miss
//     paths per Ruling 9.

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const ENGAGEMENT_A = '33333333-3333-7333-8333-333333333333';
const EVENT_1 = '00000000-0000-7000-8000-000000000001';

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EVENT_1,
    tenant_id: TENANT_A,
    engagement_id: ENGAGEMENT_A,
    event_type: 'state_transition',
    event_payload: { from: 'surfaced', to: 'evaluated' },
    created_at: new Date('2026-05-25T15:00:00Z'),
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
  talentEngagementEvent: {
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
    talentEngagementEvent: {
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

describe('EngagementEventRepository (M5 PR-2 unit)', () => {
  let prisma: MockPrisma;
  let logger: ReturnType<typeof makeSpyLogger>;
  let repo: EngagementEventRepository;

  beforeEach(() => {
    prisma = makeMockPrisma();
    logger = makeSpyLogger();
    repo = new EngagementEventRepository(prisma as unknown as PrismaService, logger);
  });

  it('exposes exactly the 5 enumerated methods', () => {
    expect(typeof repo.appendEvent).toBe('function');
    expect(typeof repo.findById).toBe('function');
    expect(typeof repo.findByEngagementId).toBe('function');
    expect(typeof repo.findByTenantAndEngagementId).toBe('function');
    expect(typeof repo.findByTenantAndId).toBe('function');
  });

  describe('appendEvent', () => {
    const input: AppendEventInput = {
      id: EVENT_1,
      tenant_id: TENANT_A,
      engagement_id: ENGAGEMENT_A,
      event_type: 'state_transition',
      event_payload: { from: 'surfaced', to: 'evaluated' },
    };

    it('calls prisma.talentEngagementEvent.create exactly once', async () => {
      prisma.talentEngagementEvent.create.mockResolvedValue(makeRow());
      await repo.appendEvent(input);
      expect(prisma.talentEngagementEvent.create).toHaveBeenCalledTimes(1);
      expect(prisma.talentEngagementEvent.create).toHaveBeenCalledWith({
        data: {
          id: input.id,
          tenant_id: input.tenant_id,
          engagement_id: input.engagement_id,
          event_type: input.event_type,
          event_payload: input.event_payload,
        },
      });
    });

    it('returns projected view with all 6 fields', async () => {
      prisma.talentEngagementEvent.create.mockResolvedValue(makeRow());
      const view = await repo.appendEvent(input);
      expect(view.id).toBe(EVENT_1);
      expect(view.tenant_id).toBe(TENANT_A);
      expect(view.engagement_id).toBe(ENGAGEMENT_A);
      expect(view.event_type).toBe('state_transition');
      expect(view.event_payload).toEqual({ from: 'surfaced', to: 'evaluated' });
      expect(view.created_at).toBeInstanceOf(Date);
    });

    it('emits append_started and appended log events', async () => {
      prisma.talentEngagementEvent.create.mockResolvedValue(makeRow());
      await repo.appendEvent(input);
      const events = logger.log.mock.calls.map((c) => (c[0] as { event: string }).event);
      expect(events).toContain('engagement_event.append_started');
      expect(events).toContain('engagement_event.appended');
    });

    it('never invokes update/upsert/delete primitives', async () => {
      prisma.talentEngagementEvent.create.mockResolvedValue(makeRow());
      await repo.appendEvent(input);
      expect(prisma.talentEngagementEvent.update).not.toHaveBeenCalled();
      expect(prisma.talentEngagementEvent.updateMany).not.toHaveBeenCalled();
      expect(prisma.talentEngagementEvent.upsert).not.toHaveBeenCalled();
      expect(prisma.talentEngagementEvent.delete).not.toHaveBeenCalled();
      expect(prisma.talentEngagementEvent.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('returns view on hit; emits hit-event', async () => {
      prisma.talentEngagementEvent.findUnique.mockResolvedValue(makeRow());
      const view = await repo.findById(EVENT_1);
      expect(view).not.toBeNull();
      expect(view?.id).toBe(EVENT_1);
      const last = logger.log.mock.calls[0]?.[0] as { event: string; hit: boolean };
      expect(last.event).toBe('engagement_event.findById');
      expect(last.hit).toBe(true);
    });

    it('returns null on miss; emits miss-event', async () => {
      prisma.talentEngagementEvent.findUnique.mockResolvedValue(null);
      const view = await repo.findById(EVENT_1);
      expect(view).toBeNull();
      const last = logger.log.mock.calls[0]?.[0] as { hit: boolean };
      expect(last.hit).toBe(false);
    });

    it('does not invoke any write primitive', async () => {
      prisma.talentEngagementEvent.findUnique.mockResolvedValue(makeRow());
      await repo.findById(EVENT_1);
      expect(prisma.talentEngagementEvent.create).not.toHaveBeenCalled();
      expect(prisma.talentEngagementEvent.update).not.toHaveBeenCalled();
      expect(prisma.talentEngagementEvent.upsert).not.toHaveBeenCalled();
      expect(prisma.talentEngagementEvent.delete).not.toHaveBeenCalled();
    });
  });

  describe('findByEngagementId', () => {
    it('returns rows ordered ASC by created_at; emits result_count', async () => {
      const rows = [makeRow({ id: 'a' }), makeRow({ id: 'b' })];
      prisma.talentEngagementEvent.findMany.mockResolvedValue(rows);
      const views = await repo.findByEngagementId(ENGAGEMENT_A);
      expect(views).toHaveLength(2);
      expect(prisma.talentEngagementEvent.findMany).toHaveBeenCalledWith({
        where: { engagement_id: ENGAGEMENT_A },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      });
      const last = logger.log.mock.calls[0]?.[0] as { result_count: number };
      expect(last.result_count).toBe(2);
    });

    it('does not invoke any write primitive', async () => {
      prisma.talentEngagementEvent.findMany.mockResolvedValue([]);
      await repo.findByEngagementId(ENGAGEMENT_A);
      expect(prisma.talentEngagementEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('findByTenantAndEngagementId', () => {
    it('scopes by tenant + engagement; emits result_count', async () => {
      prisma.talentEngagementEvent.findMany.mockResolvedValue([makeRow()]);
      const views = await repo.findByTenantAndEngagementId({
        tenant_id: TENANT_A,
        engagement_id: ENGAGEMENT_A,
      });
      expect(views).toHaveLength(1);
      expect(prisma.talentEngagementEvent.findMany).toHaveBeenCalledWith({
        where: { tenant_id: TENANT_A, engagement_id: ENGAGEMENT_A },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      });
    });
  });

  describe('findByTenantAndId (cross-schema validator consumer)', () => {
    it('scopes by tenant_id via findFirst', async () => {
      prisma.talentEngagementEvent.findFirst.mockResolvedValue(makeRow());
      const view = await repo.findByTenantAndId({ tenant_id: TENANT_A, id: EVENT_1 });
      expect(view).not.toBeNull();
      expect(prisma.talentEngagementEvent.findFirst).toHaveBeenCalledWith({
        where: { tenant_id: TENANT_A, id: EVENT_1 },
      });
    });

    it('returns null on cross-tenant lookup', async () => {
      prisma.talentEngagementEvent.findFirst.mockResolvedValue(null);
      const view = await repo.findByTenantAndId({ tenant_id: TENANT_B, id: EVENT_1 });
      expect(view).toBeNull();
    });
  });
});
