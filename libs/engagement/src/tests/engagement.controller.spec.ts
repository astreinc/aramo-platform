import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AramoError, type AramoLogger } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import type { IdempotencyService } from '@aramo/consent';

import { EngagementController } from '../lib/engagement.controller.js';
import type { CreateEngagementRequestDto } from '../lib/dto/create-engagement-request.dto.js';
import type { TransitionEngagementRequestDto } from '../lib/dto/transition-engagement-request.dto.js';
import type { EngagementRepository } from '../lib/engagement.repository.js';
import type { EngagementEventRepository } from '../lib/engagement-event.repository.js';

// M5 PR-4 §4.11 — unit spec for EngagementController.
//
// 4 endpoints × happy + refusal matrix. Vitest mocks repository +
// idempotency service.

function makeSpyLogger(): AramoLogger & { log: ReturnType<typeof vi.fn> } {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as AramoLogger & { log: ReturnType<typeof vi.fn> };
}

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TALENT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const REQ_A = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const EXAM_A = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const ENGAGEMENT_1 = '00000000-0000-7000-8000-000000000001';
const EVENT_1 = '00000000-0000-7000-8000-0000eeee0001';
const RECRUITER_SUB = '00000000-0000-7000-8000-0000aabbccdd';
const PORTAL_SUB = '00000000-0000-7000-8000-0000bbbbcccc';
const REQUEST_ID = 'rrrrrrrr-rrrr-7rrr-8rrr-rrrrrrrrrrrr';
const VALID_IDEM_KEY = 'cafecafe-cafe-7000-8000-cafecafecafe';

function recruiterAuthContext(): AuthContextType {
  return {
    sub: RECRUITER_SUB,
    consumer_type: 'recruiter',
    actor_kind: 'user',
    tenant_id: TENANT_A,
    scopes: [],
    iat: 0,
    exp: 0,
  } as unknown as AuthContextType;
}

function portalAuthContext(): AuthContextType {
  return {
    sub: PORTAL_SUB,
    consumer_type: 'portal',
    actor_kind: 'user',
    tenant_id: TENANT_A,
    scopes: [],
    iat: 0,
    exp: 0,
  } as unknown as AuthContextType;
}

interface MockEngagementRepository {
  createEngagement: ReturnType<typeof vi.fn>;
  transitionState: ReturnType<typeof vi.fn>;
  findByTenantAndId: ReturnType<typeof vi.fn>;
}
interface MockEngagementEventRepository {
  findByTenantAndEngagementId: ReturnType<typeof vi.fn>;
}
interface MockIdempotencyService {
  lookup: ReturnType<typeof vi.fn>;
  persist: ReturnType<typeof vi.fn>;
}

function makeMocks(): {
  engagementRepo: MockEngagementRepository;
  eventRepo: MockEngagementEventRepository;
  idempotency: MockIdempotencyService;
  logger: ReturnType<typeof makeSpyLogger>;
  controller: EngagementController;
} {
  const engagementRepo: MockEngagementRepository = {
    createEngagement: vi.fn(),
    transitionState: vi.fn(),
    findByTenantAndId: vi.fn(),
  };
  const eventRepo: MockEngagementEventRepository = {
    findByTenantAndEngagementId: vi.fn(),
  };
  const idempotency: MockIdempotencyService = {
    lookup: vi.fn().mockResolvedValue({ kind: 'proceed' }),
    persist: vi.fn().mockResolvedValue(undefined),
  };
  const logger = makeSpyLogger();
  const controller = new EngagementController(
    engagementRepo as unknown as EngagementRepository,
    eventRepo as unknown as EngagementEventRepository,
    idempotency as unknown as IdempotencyService,
    logger,
  );
  return { engagementRepo, eventRepo, idempotency, logger, controller };
}

function makeEngagementView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ENGAGEMENT_1,
    tenant_id: TENANT_A,
    talent_id: TALENT_A,
    requisition_id: REQ_A,
    examination_id: EXAM_A,
    state: 'surfaced',
    created_at: new Date('2026-05-25T10:00:00Z'),
    ...overrides,
  };
}

describe('EngagementController.createEngagement (M5 PR-4 unit)', () => {
  let m: ReturnType<typeof makeMocks>;
  const body: CreateEngagementRequestDto = {
    talent_id: TALENT_A,
    requisition_id: REQ_A,
    examination_id: EXAM_A,
  };

  beforeEach(() => {
    m = makeMocks();
  });

  it('happy: 201 + repository.createEngagement called + idempotency.persist called', async () => {
    m.engagementRepo.createEngagement.mockResolvedValue({
      engagement: makeEngagementView(),
      event: {},
    });
    const res = await m.controller.createEngagement(
      body,
      VALID_IDEM_KEY,
      recruiterAuthContext(),
      REQUEST_ID,
    );
    expect(res.engagement.id).toBe(ENGAGEMENT_1);
    expect(m.engagementRepo.createEngagement).toHaveBeenCalledTimes(1);
    expect(m.idempotency.persist).toHaveBeenCalledTimes(1);
  });

  it('INSUFFICIENT_PERMISSIONS 403 on non-recruiter consumer', async () => {
    await expect(
      m.controller.createEngagement(body, VALID_IDEM_KEY, portalAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    expect(m.engagementRepo.createEngagement).not.toHaveBeenCalled();
  });

  it('VALIDATION_ERROR 400 on missing Idempotency-Key', async () => {
    await expect(
      m.controller.createEngagement(body, undefined, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });

  it('VALIDATION_ERROR 400 on non-UUID Idempotency-Key', async () => {
    await expect(
      m.controller.createEngagement(body, 'not-a-uuid', recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });

  it('ENGAGEMENT_REFERENCE_NOT_FOUND propagates from repository with requestId re-binding', async () => {
    m.engagementRepo.createEngagement.mockRejectedValue(
      new AramoError('ENGAGEMENT_REFERENCE_NOT_FOUND', 'Talent not visible in tenant', 422, {
        requestId: 'engagement-create',
        details: { field: 'talent_id' },
      }),
    );
    try {
      await m.controller.createEngagement(body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID);
      throw new Error('expected throw');
    } catch (err) {
      const e = err as AramoError;
      expect(e.code).toBe('ENGAGEMENT_REFERENCE_NOT_FOUND');
      expect(e.statusCode).toBe(422);
      expect(e.context.requestId).toBe(REQUEST_ID);
    }
  });

  it('IDEMPOTENCY_KEY_CONFLICT 409 propagates from idempotency.lookup', async () => {
    m.idempotency.lookup.mockRejectedValue(
      new AramoError('IDEMPOTENCY_KEY_CONFLICT', 'collision', 409, { requestId: REQUEST_ID }),
    );
    await expect(
      m.controller.createEngagement(body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT', statusCode: 409 });
    expect(m.engagementRepo.createEngagement).not.toHaveBeenCalled();
  });

  it('replay: idempotency.lookup returns prior body; repository NOT called', async () => {
    const priorResponse = { engagement: makeEngagementView() };
    m.idempotency.lookup.mockResolvedValue({
      kind: 'replay',
      response_status: 201,
      response_body: priorResponse,
    });
    const res = await m.controller.createEngagement(
      body,
      VALID_IDEM_KEY,
      recruiterAuthContext(),
      REQUEST_ID,
    );
    expect(res).toBe(priorResponse);
    expect(m.engagementRepo.createEngagement).not.toHaveBeenCalled();
    expect(m.idempotency.persist).not.toHaveBeenCalled();
  });
});

describe('EngagementController.transitionEngagement (M5 PR-4 unit)', () => {
  let m: ReturnType<typeof makeMocks>;
  const body: TransitionEngagementRequestDto = {
    to_state: 'evaluated',
    event_id: EVENT_1,
  };

  beforeEach(() => {
    m = makeMocks();
  });

  it('happy: 200 + repository.transitionState called', async () => {
    m.engagementRepo.transitionState.mockResolvedValue({
      engagement: makeEngagementView({ state: 'evaluated' }),
      event: {},
    });
    const res = await m.controller.transitionEngagement(
      ENGAGEMENT_1,
      body,
      VALID_IDEM_KEY,
      recruiterAuthContext(),
      REQUEST_ID,
    );
    expect(res.engagement.state).toBe('evaluated');
    expect(m.engagementRepo.transitionState).toHaveBeenCalledTimes(1);
  });

  it('INSUFFICIENT_PERMISSIONS 403 on portal', async () => {
    await expect(
      m.controller.transitionEngagement(ENGAGEMENT_1, body, VALID_IDEM_KEY, portalAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
  });

  it('VALIDATION_ERROR 400 on bad engagement_id', async () => {
    await expect(
      m.controller.transitionEngagement('not-a-uuid', body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('ENGAGEMENT_STATE_INVALID propagates with requestId re-binding', async () => {
    m.engagementRepo.transitionState.mockRejectedValue(
      new AramoError('ENGAGEMENT_STATE_INVALID', 'illegal', 422, {
        requestId: 'engagement-transition',
        details: { from_state: 'surfaced', to_state: 'submitted' },
      }),
    );
    try {
      await m.controller.transitionEngagement(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID);
      throw new Error('expected throw');
    } catch (err) {
      const e = err as AramoError;
      expect(e.code).toBe('ENGAGEMENT_STATE_INVALID');
      expect(e.context.requestId).toBe(REQUEST_ID);
    }
  });

  it('NOT_FOUND 404 propagates', async () => {
    m.engagementRepo.transitionState.mockRejectedValue(
      new AramoError('NOT_FOUND', 'missing', 404, { requestId: 'engagement-transition' }),
    );
    await expect(
      m.controller.transitionEngagement(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });
});

describe('EngagementController.getEngagement (M5 PR-4 unit)', () => {
  let m: ReturnType<typeof makeMocks>;

  beforeEach(() => {
    m = makeMocks();
  });

  it('happy: returns engagement view', async () => {
    m.engagementRepo.findByTenantAndId.mockResolvedValue(makeEngagementView());
    const res = await m.controller.getEngagement(ENGAGEMENT_1, recruiterAuthContext(), REQUEST_ID);
    expect(res.id).toBe(ENGAGEMENT_1);
  });

  it('INSUFFICIENT_PERMISSIONS on portal', async () => {
    await expect(
      m.controller.getEngagement(ENGAGEMENT_1, portalAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
  });

  it('NOT_FOUND 404 when repository returns null', async () => {
    m.engagementRepo.findByTenantAndId.mockResolvedValue(null);
    await expect(
      m.controller.getEngagement(ENGAGEMENT_1, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });

  it('VALIDATION_ERROR 400 on non-UUID id', async () => {
    await expect(
      m.controller.getEngagement('not-a-uuid', recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('EngagementController.getEngagementEvents (M5 PR-4 unit)', () => {
  let m: ReturnType<typeof makeMocks>;

  beforeEach(() => {
    m = makeMocks();
  });

  it('happy: returns events array', async () => {
    m.engagementRepo.findByTenantAndId.mockResolvedValue(makeEngagementView());
    m.eventRepo.findByTenantAndEngagementId.mockResolvedValue([
      { id: 'e1', tenant_id: TENANT_A, engagement_id: ENGAGEMENT_1, event_type: 'state_transition', event_payload: {}, created_at: new Date() },
    ]);
    const res = await m.controller.getEngagementEvents(ENGAGEMENT_1, recruiterAuthContext(), REQUEST_ID);
    expect(res.events).toHaveLength(1);
  });

  it('INSUFFICIENT_PERMISSIONS on portal', async () => {
    await expect(
      m.controller.getEngagementEvents(ENGAGEMENT_1, portalAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
  });

  it('NOT_FOUND 404 when parent engagement does not exist (info-leak guard)', async () => {
    m.engagementRepo.findByTenantAndId.mockResolvedValue(null);
    await expect(
      m.controller.getEngagementEvents(ENGAGEMENT_1, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(m.eventRepo.findByTenantAndEngagementId).not.toHaveBeenCalled();
  });
});
