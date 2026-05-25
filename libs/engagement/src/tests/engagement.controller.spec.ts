import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AramoError, type AramoLogger } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import type { IdempotencyService } from '@aramo/consent';
import type { AiDraftService } from '@aramo/ai-draft';

import { EngagementController } from '../lib/engagement.controller.js';
import type { CreateEngagementRequestDto } from '../lib/dto/create-engagement-request.dto.js';
import type { OutreachSendRequestDto } from '../lib/dto/outreach-send-request.dto.js';
import type { TransitionEngagementRequestDto } from '../lib/dto/transition-engagement-request.dto.js';
import type { DeliveryProvider } from '../lib/delivery/delivery-provider.interface.js';
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
  sendOutreach: ReturnType<typeof vi.fn>;
  findByTenantAndId: ReturnType<typeof vi.fn>;
}
interface MockEngagementEventRepository {
  findByTenantAndEngagementId: ReturnType<typeof vi.fn>;
}
interface MockIdempotencyService {
  lookup: ReturnType<typeof vi.fn>;
  persist: ReturnType<typeof vi.fn>;
}
interface MockAiDraftService {
  generateDraft: ReturnType<typeof vi.fn>;
}
interface MockDeliveryProvider {
  deliver: ReturnType<typeof vi.fn>;
}

function makeMocks(): {
  engagementRepo: MockEngagementRepository;
  eventRepo: MockEngagementEventRepository;
  idempotency: MockIdempotencyService;
  aiDraftService: MockAiDraftService;
  deliveryProvider: MockDeliveryProvider;
  logger: ReturnType<typeof makeSpyLogger>;
  controller: EngagementController;
} {
  const engagementRepo: MockEngagementRepository = {
    createEngagement: vi.fn(),
    transitionState: vi.fn(),
    sendOutreach: vi.fn(),
    findByTenantAndId: vi.fn(),
  };
  const eventRepo: MockEngagementEventRepository = {
    findByTenantAndEngagementId: vi.fn(),
  };
  const idempotency: MockIdempotencyService = {
    lookup: vi.fn().mockResolvedValue({ kind: 'proceed' }),
    persist: vi.fn().mockResolvedValue(undefined),
  };
  const aiDraftService: MockAiDraftService = { generateDraft: vi.fn() };
  const deliveryProvider: MockDeliveryProvider = { deliver: vi.fn() };
  const logger = makeSpyLogger();
  const controller = new EngagementController(
    engagementRepo as unknown as EngagementRepository,
    eventRepo as unknown as EngagementEventRepository,
    idempotency as unknown as IdempotencyService,
    logger,
    aiDraftService as unknown as AiDraftService,
    deliveryProvider as unknown as DeliveryProvider,
  );
  return { engagementRepo, eventRepo, idempotency, aiDraftService, deliveryProvider, logger, controller };
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

// M5 PR-6 §4.16 — EngagementController.sendOutreach unit tests.
describe('EngagementController.sendOutreach (M5 PR-6 unit)', () => {
  let m: ReturnType<typeof makeMocks>;
  const body: OutreachSendRequestDto = {
    prompt: 'Reach out to talent about the role.',
    max_tokens: 256,
  };

  const draftResultFixture = {
    completion: 'mocked draft body',
    model_used: 'claude-sonnet-mock',
    input_tokens: 10,
    output_tokens: 20,
    duration_ms: 100,
    audit_record_id: '00000000-0000-7000-8000-aaaa00000a01',
  };
  const deliveryResultFixture = {
    delivered: true as const,
    delivered_at: new Date('2026-05-25T10:01:00.000Z'),
    delivery_id: '00000000-0000-7000-8000-dddd0d000001',
    delivery_channel: 'email' as const,
  };
  const sendOutreachResultFixture = {
    engagement: makeEngagementView({ state: 'awaiting_response' }),
    outreach_event: {
      id: '00000000-0000-7000-8000-eeee0e000001',
      tenant_id: TENANT_A,
      engagement_id: ENGAGEMENT_1,
      event_type: 'outreach_sent',
      event_payload: {},
      created_at: new Date('2026-05-25T10:01:00.000Z'),
    },
    transition_event: {
      id: '00000000-0000-7000-8000-eeee0e000002',
      tenant_id: TENANT_A,
      engagement_id: ENGAGEMENT_1,
      event_type: 'state_transition',
      event_payload: { from_state: 'engaged', to_state: 'awaiting_response' },
      created_at: new Date('2026-05-25T10:01:00.000Z'),
    },
  };

  beforeEach(() => {
    m = makeMocks();
  });

  function arrangeHappyPath(): void {
    m.aiDraftService.generateDraft.mockResolvedValue(draftResultFixture);
    m.deliveryProvider.deliver.mockResolvedValue(deliveryResultFixture);
    m.engagementRepo.sendOutreach.mockResolvedValue(sendOutreachResultFixture);
  }

  it('happy: 200 + AiDraft + Delivery + repository.sendOutreach all called; idempotency.persist called', async () => {
    arrangeHappyPath();
    const res = await m.controller.sendOutreach(
      ENGAGEMENT_1,
      body,
      VALID_IDEM_KEY,
      recruiterAuthContext(),
      REQUEST_ID,
    );
    expect(res.engagement.state).toBe('awaiting_response');
    expect(res.delivery_id).toBe(deliveryResultFixture.delivery_id);
    expect(m.aiDraftService.generateDraft).toHaveBeenCalledTimes(1);
    expect(m.deliveryProvider.deliver).toHaveBeenCalledTimes(1);
    expect(m.engagementRepo.sendOutreach).toHaveBeenCalledTimes(1);
    expect(m.idempotency.persist).toHaveBeenCalledTimes(1);
  });

  it('INSUFFICIENT_PERMISSIONS 403 on portal consumer; AI + delivery + repo NOT called', async () => {
    await expect(
      m.controller.sendOutreach(ENGAGEMENT_1, body, VALID_IDEM_KEY, portalAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    expect(m.aiDraftService.generateDraft).not.toHaveBeenCalled();
    expect(m.deliveryProvider.deliver).not.toHaveBeenCalled();
    expect(m.engagementRepo.sendOutreach).not.toHaveBeenCalled();
  });

  it('VALIDATION_ERROR 400 on missing Idempotency-Key', async () => {
    await expect(
      m.controller.sendOutreach(ENGAGEMENT_1, body, undefined, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    expect(m.aiDraftService.generateDraft).not.toHaveBeenCalled();
  });

  it('NOT_FOUND 404 propagates from repository.sendOutreach with requestId re-binding', async () => {
    m.aiDraftService.generateDraft.mockResolvedValue(draftResultFixture);
    m.deliveryProvider.deliver.mockResolvedValue(deliveryResultFixture);
    m.engagementRepo.sendOutreach.mockRejectedValue(
      new AramoError('NOT_FOUND', 'TalentJobEngagement not found', 404, {
        requestId: 'engagement-outreach',
        details: { engagement_id: ENGAGEMENT_1 },
      }),
    );
    try {
      await m.controller.sendOutreach(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID);
      throw new Error('expected throw');
    } catch (err) {
      const e = err as AramoError;
      expect(e.code).toBe('NOT_FOUND');
      expect(e.statusCode).toBe(404);
      expect(e.context.requestId).toBe(REQUEST_ID);
    }
  });

  it('ENGAGEMENT_STATE_INVALID 422 propagates from repository.sendOutreach', async () => {
    m.aiDraftService.generateDraft.mockResolvedValue(draftResultFixture);
    m.deliveryProvider.deliver.mockResolvedValue(deliveryResultFixture);
    m.engagementRepo.sendOutreach.mockRejectedValue(
      new AramoError('ENGAGEMENT_STATE_INVALID', 'illegal', 422, {
        requestId: 'engagement-outreach',
        details: { from_state: 'surfaced', to_state: 'awaiting_response' },
      }),
    );
    await expect(
      m.controller.sendOutreach(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'ENGAGEMENT_STATE_INVALID', statusCode: 422 });
  });

  it('AI_PROVIDER_UNAVAILABLE 502 remaps INTERNAL_ERROR kind=provider_unavailable', async () => {
    m.aiDraftService.generateDraft.mockRejectedValue(
      new AramoError('INTERNAL_ERROR', 'connection refused', 502, {
        requestId: 'ai-draft',
        details: { kind: 'provider_unavailable' },
      }),
    );
    try {
      await m.controller.sendOutreach(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID);
      throw new Error('expected throw');
    } catch (err) {
      const e = err as AramoError;
      expect(e.code).toBe('AI_PROVIDER_UNAVAILABLE');
      expect(e.statusCode).toBe(502);
      expect(e.context.details?.['kind']).toBe('provider_unavailable');
    }
    expect(m.deliveryProvider.deliver).not.toHaveBeenCalled();
    expect(m.engagementRepo.sendOutreach).not.toHaveBeenCalled();
  });

  it('AI_RATE_LIMITED 429 remaps INTERNAL_ERROR kind=provider_rate_limited', async () => {
    m.aiDraftService.generateDraft.mockRejectedValue(
      new AramoError('INTERNAL_ERROR', 'rate limited', 429, {
        requestId: 'ai-draft',
        details: { kind: 'provider_rate_limited' },
      }),
    );
    try {
      await m.controller.sendOutreach(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID);
      throw new Error('expected throw');
    } catch (err) {
      const e = err as AramoError;
      expect(e.code).toBe('AI_RATE_LIMITED');
      expect(e.statusCode).toBe(429);
    }
    expect(m.deliveryProvider.deliver).not.toHaveBeenCalled();
  });

  it('INTERNAL_ERROR passes through for other kinds (e.g. provider_auth_failed) — NOT remapped', async () => {
    m.aiDraftService.generateDraft.mockRejectedValue(
      new AramoError('INTERNAL_ERROR', 'auth failed', 500, {
        requestId: 'ai-draft',
        details: { kind: 'provider_auth_failed' },
      }),
    );
    try {
      await m.controller.sendOutreach(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID);
      throw new Error('expected throw');
    } catch (err) {
      const e = err as AramoError;
      expect(e.code).toBe('INTERNAL_ERROR');
      expect(e.statusCode).toBe(500);
    }
  });

  it('IDEMPOTENCY_KEY_CONFLICT 409 propagates from idempotency.lookup; AI not called', async () => {
    m.idempotency.lookup.mockRejectedValue(
      new AramoError('IDEMPOTENCY_KEY_CONFLICT', 'collision', 409, { requestId: REQUEST_ID }),
    );
    await expect(
      m.controller.sendOutreach(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT', statusCode: 409 });
    expect(m.aiDraftService.generateDraft).not.toHaveBeenCalled();
  });

  it('idempotency replay: lookup returns prior body; AI + delivery + repo NOT called', async () => {
    const priorResponse = {
      engagement: makeEngagementView({ state: 'awaiting_response' }),
      outreach_event: sendOutreachResultFixture.outreach_event,
      delivery_id: deliveryResultFixture.delivery_id,
    };
    m.idempotency.lookup.mockResolvedValue({
      kind: 'replay',
      response_status: 200,
      response_body: priorResponse,
    });
    const res = await m.controller.sendOutreach(
      ENGAGEMENT_1,
      body,
      VALID_IDEM_KEY,
      recruiterAuthContext(),
      REQUEST_ID,
    );
    expect(res).toBe(priorResponse);
    expect(m.aiDraftService.generateDraft).not.toHaveBeenCalled();
    expect(m.deliveryProvider.deliver).not.toHaveBeenCalled();
    expect(m.engagementRepo.sendOutreach).not.toHaveBeenCalled();
    expect(m.idempotency.persist).not.toHaveBeenCalled();
  });
});
