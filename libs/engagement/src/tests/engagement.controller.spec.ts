import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AramoError, type AramoLogger } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import type { ConsentService, IdempotencyService } from '@aramo/consent';
import type { AiDraftService } from '@aramo/ai-draft';

import { EngagementController } from '../lib/engagement.controller.js';
import type { CreateEngagementRequestDto } from '../lib/dto/create-engagement-request.dto.js';
import type { OutreachDraftRequestDto } from '../lib/dto/outreach-draft-request.dto.js';
import type { OutreachSendRequestDto } from '../lib/dto/outreach-send-request.dto.js';
import type { RecordResponseRequestDto } from '../lib/dto/record-response-request.dto.js';
import type { RecordConversationStartedRequestDto } from '../lib/dto/record-conversation-started-request.dto.js';
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
  draftOutreach: ReturnType<typeof vi.fn>;
  sendOutreach: ReturnType<typeof vi.fn>;
  recordResponse: ReturnType<typeof vi.fn>;
  recordConversationStarted: ReturnType<typeof vi.fn>;
  findByTenantAndId: ReturnType<typeof vi.fn>;
}
interface MockEngagementEventRepository {
  findByTenantAndEngagementId: ReturnType<typeof vi.fn>;
  // Outreach Draft/Preview split — SEND resolves the source draft event
  // via the event repo's findByTenantAndId (cross-event-ref guard).
  findByTenantAndId: ReturnType<typeof vi.fn>;
}
interface MockIdempotencyService {
  lookup: ReturnType<typeof vi.fn>;
  persist: ReturnType<typeof vi.fn>;
}
interface MockConsentService {
  check: ReturnType<typeof vi.fn>;
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
  consentService: MockConsentService;
  aiDraftService: MockAiDraftService;
  deliveryProvider: MockDeliveryProvider;
  logger: ReturnType<typeof makeSpyLogger>;
  controller: EngagementController;
} {
  const engagementRepo: MockEngagementRepository = {
    createEngagement: vi.fn(),
    transitionState: vi.fn(),
    draftOutreach: vi.fn(),
    sendOutreach: vi.fn(),
    recordResponse: vi.fn(),
    recordConversationStarted: vi.fn(),
    // Outreach draft + send both pre-read via findByTenantAndId to extract
    // talent_id (consent) + state (the engaged gate). Default to a valid
    // engaged engagement so happy-path tests flow; NOT_FOUND / non-engaged
    // tests override per-call.
    findByTenantAndId: vi.fn().mockResolvedValue({
      id: ENGAGEMENT_1,
      tenant_id: TENANT_A,
      talent_id: TALENT_A,
      requisition_id: REQ_A,
      examination_id: EXAM_A,
      state: 'engaged',
      created_at: new Date('2026-05-25T10:00:00Z'),
    }),
  };
  const eventRepo: MockEngagementEventRepository = {
    findByTenantAndEngagementId: vi.fn(),
    // SEND resolves the source draft event here; default to a valid
    // outreach_drafted event on ENGAGEMENT_1 so send happy-path flows.
    findByTenantAndId: vi.fn().mockResolvedValue({
      id: '00000000-0000-7000-8000-dddd00000001',
      tenant_id: TENANT_A,
      engagement_id: ENGAGEMENT_1,
      event_type: 'outreach_drafted',
      event_payload: {
        draft_text: 'mocked draft body',
        ai_draft_audit_record_id: '00000000-0000-7000-8000-aaaa00000a01',
        model_used: 'claude-sonnet-mock',
        input_tokens: 10,
        output_tokens: 20,
        duration_ms: 100,
        prompt: 'Reach out to talent about the role.',
        max_tokens: 256,
      },
      created_at: new Date('2026-05-25T10:00:30Z'),
    }),
  };
  const idempotency: MockIdempotencyService = {
    lookup: vi.fn().mockResolvedValue({ kind: 'proceed' }),
    persist: vi.fn().mockResolvedValue(undefined),
  };
  // M5 PR-9b §4.1 — default consent check returns 'allowed' so existing
  // happy-path unit tests continue to flow through to Step 6 AI draft.
  // Refusal tests can override per-call via mockResolvedValueOnce.
  const consentService: MockConsentService = {
    check: vi.fn().mockResolvedValue({
      result: 'allowed',
      decision_id: '00000000-0000-7000-8000-aaaa00000099',
      computed_at: '2026-05-27T10:00:00.000Z',
    }),
  };
  const aiDraftService: MockAiDraftService = { generateDraft: vi.fn() };
  const deliveryProvider: MockDeliveryProvider = { deliver: vi.fn() };
  const logger = makeSpyLogger();
  const controller = new EngagementController(
    engagementRepo as unknown as EngagementRepository,
    eventRepo as unknown as EngagementEventRepository,
    idempotency as unknown as IdempotencyService,
    consentService as unknown as ConsentService,
    logger,
    aiDraftService as unknown as AiDraftService,
    deliveryProvider as unknown as DeliveryProvider,
  );
  return { engagementRepo, eventRepo, idempotency, consentService, aiDraftService, deliveryProvider, logger, controller };
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

// Outreach Draft/Preview split — shared fixtures.
const DRAFT_EVENT_ID = '00000000-0000-7000-8000-dddd00000001';

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

// ---- DRAFT endpoint (Outreach Draft/Preview Amendment v1.1 §1) ----------
describe('EngagementController.draftOutreach (Outreach Draft/Preview unit)', () => {
  let m: ReturnType<typeof makeMocks>;
  const body: OutreachDraftRequestDto = {
    prompt: 'Reach out to talent about the role.',
    max_tokens: 256,
  };

  const draftOutreachResultFixture = {
    draft_event: {
      id: DRAFT_EVENT_ID,
      tenant_id: TENANT_A,
      engagement_id: ENGAGEMENT_1,
      event_type: 'outreach_drafted',
      event_payload: {},
      created_at: new Date('2026-05-25T10:00:30.000Z'),
    },
  };

  beforeEach(() => {
    m = makeMocks();
    m.aiDraftService.generateDraft.mockResolvedValue(draftResultFixture);
    m.engagementRepo.draftOutreach.mockResolvedValue(draftOutreachResultFixture);
  });

  it('happy: 200 + generateDraft + repo.draftOutreach; NO delivery / NO send; returns draft_event_id + draft_text', async () => {
    const res = await m.controller.draftOutreach(
      ENGAGEMENT_1,
      body,
      VALID_IDEM_KEY,
      recruiterAuthContext(),
      REQUEST_ID,
    );
    expect(res.draft_event_id).toBe(DRAFT_EVENT_ID);
    expect(res.draft_text).toBe('mocked draft body');
    expect(res.ai_draft_audit_record_id).toBe(draftResultFixture.audit_record_id);
    expect(res.consent_warning).toBeUndefined();
    expect(m.aiDraftService.generateDraft).toHaveBeenCalledTimes(1);
    expect(m.engagementRepo.draftOutreach).toHaveBeenCalledTimes(1);
    // The compliance heart: drafting NEVER delivers or sends.
    expect(m.deliveryProvider.deliver).not.toHaveBeenCalled();
    expect(m.engagementRepo.sendOutreach).not.toHaveBeenCalled();
    expect(m.idempotency.persist).toHaveBeenCalledTimes(1);
    // The persisted drafted payload carries the AI text + audit linkage.
    const draftArg = m.engagementRepo.draftOutreach.mock.calls[0][0];
    expect(draftArg.drafted_payload.draft_text).toBe('mocked draft body');
    expect(draftArg.drafted_payload.prompt).toBe(body.prompt);
  });

  it('INSUFFICIENT_PERMISSIONS 403 on portal consumer; generateDraft + repo NOT called', async () => {
    await expect(
      m.controller.draftOutreach(ENGAGEMENT_1, body, VALID_IDEM_KEY, portalAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    expect(m.aiDraftService.generateDraft).not.toHaveBeenCalled();
    expect(m.engagementRepo.draftOutreach).not.toHaveBeenCalled();
  });

  it('VALIDATION_ERROR 400 on missing Idempotency-Key', async () => {
    await expect(
      m.controller.draftOutreach(ENGAGEMENT_1, body, undefined, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    expect(m.aiDraftService.generateDraft).not.toHaveBeenCalled();
  });

  it('NOT_FOUND 404 at pre-read; consent + generateDraft NOT reached', async () => {
    m.engagementRepo.findByTenantAndId.mockResolvedValue(null);
    await expect(
      m.controller.draftOutreach(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(m.consentService.check).not.toHaveBeenCalled();
    expect(m.aiDraftService.generateDraft).not.toHaveBeenCalled();
    expect(m.engagementRepo.draftOutreach).not.toHaveBeenCalled();
  });

  // Amendment v1.1 Ruling 2 — DRAFT is GATED to engaged: a non-engaged
  // engagement 422s BEFORE generateDraft (no stranded drafts, no wasted LLM).
  it('ENGAGEMENT_STATE_INVALID 422 when engagement not in engaged state; generateDraft NOT called', async () => {
    m.engagementRepo.findByTenantAndId.mockResolvedValue({
      id: ENGAGEMENT_1,
      tenant_id: TENANT_A,
      talent_id: TALENT_A,
      requisition_id: REQ_A,
      examination_id: EXAM_A,
      state: 'surfaced',
      created_at: new Date('2026-05-25T10:00:00Z'),
    });
    await expect(
      m.controller.draftOutreach(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'ENGAGEMENT_STATE_INVALID', statusCode: 422 });
    expect(m.aiDraftService.generateDraft).not.toHaveBeenCalled();
    expect(m.engagementRepo.draftOutreach).not.toHaveBeenCalled();
  });

  // Amendment v1.1 Ruling 1 — SOFT consent: denied does NOT block drafting;
  // the response carries a non-blocking consent_warning instead.
  it('soft consent: denied → still drafts, returns consent_warning; NO 403, NO delivery', async () => {
    m.consentService.check.mockResolvedValueOnce({
      result: 'denied',
      reason_code: 'stale_consent',
      display_message: 'Contacting consent is stale.',
      decision_id: '00000000-0000-7000-8000-aaaa00000d01',
      computed_at: '2026-05-27T10:00:00.000Z',
    });
    const res = await m.controller.draftOutreach(
      ENGAGEMENT_1,
      body,
      VALID_IDEM_KEY,
      recruiterAuthContext(),
      REQUEST_ID,
    );
    expect(res.draft_event_id).toBe(DRAFT_EVENT_ID);
    expect(res.consent_warning).toEqual({
      reason_code: 'stale_consent',
      display_message: 'Contacting consent is stale.',
    });
    expect(m.aiDraftService.generateDraft).toHaveBeenCalledTimes(1);
    expect(m.engagementRepo.draftOutreach).toHaveBeenCalledTimes(1);
    expect(m.deliveryProvider.deliver).not.toHaveBeenCalled();
  });

  it('AI_PROVIDER_UNAVAILABLE 502 remaps INTERNAL_ERROR kind=provider_unavailable', async () => {
    m.aiDraftService.generateDraft.mockRejectedValue(
      new AramoError('INTERNAL_ERROR', 'connection refused', 502, {
        requestId: 'ai-draft',
        details: { kind: 'provider_unavailable' },
      }),
    );
    await expect(
      m.controller.draftOutreach(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE', statusCode: 502 });
    expect(m.engagementRepo.draftOutreach).not.toHaveBeenCalled();
  });

  it('AI_RATE_LIMITED 429 remaps INTERNAL_ERROR kind=provider_rate_limited', async () => {
    m.aiDraftService.generateDraft.mockRejectedValue(
      new AramoError('INTERNAL_ERROR', 'rate limited', 429, {
        requestId: 'ai-draft',
        details: { kind: 'provider_rate_limited' },
      }),
    );
    await expect(
      m.controller.draftOutreach(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'AI_RATE_LIMITED', statusCode: 429 });
  });

  it('idempotency replay: returns prior body; generateDraft + repo NOT called', async () => {
    const priorResponse = { draft_event_id: DRAFT_EVENT_ID, draft_text: 'x', ai_draft_audit_record_id: 'y' };
    m.idempotency.lookup.mockResolvedValue({
      kind: 'replay',
      response_status: 200,
      response_body: priorResponse,
    });
    const res = await m.controller.draftOutreach(
      ENGAGEMENT_1,
      body,
      VALID_IDEM_KEY,
      recruiterAuthContext(),
      REQUEST_ID,
    );
    expect(res).toBe(priorResponse);
    expect(m.aiDraftService.generateDraft).not.toHaveBeenCalled();
    expect(m.engagementRepo.draftOutreach).not.toHaveBeenCalled();
    expect(m.idempotency.persist).not.toHaveBeenCalled();
  });
});

// ---- SEND endpoint (Outreach Draft/Preview Amendment v1.1 §2) -----------
describe('EngagementController.sendOutreach (Outreach Draft/Preview unit)', () => {
  let m: ReturnType<typeof makeMocks>;
  const body: OutreachSendRequestDto = {
    draft_event_id: DRAFT_EVENT_ID,
    final_text: 'Edited final text the recruiter approved.',
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
    m.deliveryProvider.deliver.mockResolvedValue(deliveryResultFixture);
    m.engagementRepo.sendOutreach.mockResolvedValue(sendOutreachResultFixture);
  });

  it('happy: 200 + delivery(final_text) + repo.sendOutreach; NO generateDraft at send; persist called', async () => {
    const res = await m.controller.sendOutreach(
      ENGAGEMENT_1,
      body,
      VALID_IDEM_KEY,
      recruiterAuthContext(),
      REQUEST_ID,
    );
    expect(res.engagement.state).toBe('awaiting_response');
    expect(res.delivery_id).toBe(deliveryResultFixture.delivery_id);
    // SEND does NOT run the LLM — generation happened at DRAFT.
    expect(m.aiDraftService.generateDraft).not.toHaveBeenCalled();
    // Delivery carries the recruiter-approved final_text, not the raw draft.
    const deliverArg = m.deliveryProvider.deliver.mock.calls[0][0];
    expect(deliverArg.completion).toBe(body.final_text);
    expect(m.engagementRepo.sendOutreach).toHaveBeenCalledTimes(1);
    expect(m.idempotency.persist).toHaveBeenCalledTimes(1);
  });

  // The editable-trail invariant: outreach_sent persists final_text +
  // the source draft back-reference; final_text may differ from draft_text.
  it('editable trail: outreach_sent payload carries final_text + source_draft_event_id', async () => {
    await m.controller.sendOutreach(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID);
    const sendArg = m.engagementRepo.sendOutreach.mock.calls[0][0];
    expect(sendArg.source_draft_event_id).toBe(DRAFT_EVENT_ID);
    expect(sendArg.outreach_payload.final_text).toBe(body.final_text);
    expect(sendArg.outreach_payload.source_draft_event_id).toBe(DRAFT_EVENT_ID);
    // Audit/token fields carried forward FROM the draft event payload.
    expect(sendArg.outreach_payload.ai_draft_audit_record_id).toBe(
      '00000000-0000-7000-8000-aaaa00000a01',
    );
    expect(sendArg.outreach_payload.model_used).toBe('claude-sonnet-mock');
  });

  it('INSUFFICIENT_PERMISSIONS 403 on portal consumer; delivery + repo NOT called', async () => {
    await expect(
      m.controller.sendOutreach(ENGAGEMENT_1, body, VALID_IDEM_KEY, portalAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    expect(m.deliveryProvider.deliver).not.toHaveBeenCalled();
    expect(m.engagementRepo.sendOutreach).not.toHaveBeenCalled();
  });

  it('VALIDATION_ERROR 400 on missing Idempotency-Key', async () => {
    await expect(
      m.controller.sendOutreach(ENGAGEMENT_1, body, undefined, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    expect(m.deliveryProvider.deliver).not.toHaveBeenCalled();
  });

  it('NOT_FOUND 404 at pre-read; delivery + repo NOT called', async () => {
    m.engagementRepo.findByTenantAndId.mockResolvedValue(null);
    await expect(
      m.controller.sendOutreach(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(m.deliveryProvider.deliver).not.toHaveBeenCalled();
    expect(m.engagementRepo.sendOutreach).not.toHaveBeenCalled();
  });

  // True single-send: a second send finds state 'awaiting_response' and
  // 422s at the pre-gate BEFORE re-delivering.
  it('ENGAGEMENT_STATE_INVALID 422 when not engaged; delivery NOT called (no double-send)', async () => {
    m.engagementRepo.findByTenantAndId.mockResolvedValue({
      id: ENGAGEMENT_1,
      tenant_id: TENANT_A,
      talent_id: TALENT_A,
      requisition_id: REQ_A,
      examination_id: EXAM_A,
      state: 'awaiting_response',
      created_at: new Date('2026-05-25T10:00:00Z'),
    });
    await expect(
      m.controller.sendOutreach(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'ENGAGEMENT_STATE_INVALID', statusCode: 422 });
    expect(m.deliveryProvider.deliver).not.toHaveBeenCalled();
    expect(m.engagementRepo.sendOutreach).not.toHaveBeenCalled();
  });

  it('ENGAGEMENT_REFERENCE_NOT_FOUND 422 when draft_event_id does not resolve; delivery NOT called', async () => {
    m.eventRepo.findByTenantAndId.mockResolvedValue(null);
    await expect(
      m.controller.sendOutreach(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'ENGAGEMENT_REFERENCE_NOT_FOUND', statusCode: 422 });
    expect(m.deliveryProvider.deliver).not.toHaveBeenCalled();
    expect(m.engagementRepo.sendOutreach).not.toHaveBeenCalled();
  });

  it('ENGAGEMENT_REFERENCE_NOT_FOUND 422 when referenced event is not an outreach_drafted', async () => {
    m.eventRepo.findByTenantAndId.mockResolvedValue({
      id: DRAFT_EVENT_ID,
      tenant_id: TENANT_A,
      engagement_id: ENGAGEMENT_1,
      event_type: 'outreach_sent',
      event_payload: {},
      created_at: new Date('2026-05-25T10:00:30Z'),
    });
    await expect(
      m.controller.sendOutreach(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'ENGAGEMENT_REFERENCE_NOT_FOUND', statusCode: 422 });
    expect(m.deliveryProvider.deliver).not.toHaveBeenCalled();
  });

  // BINDING consent-at-send (relocated from the atomic flow to SEND).
  it('CONSENT_NOT_GRANTED_AT_SEND 403 when consent denied at send; delivery + repo NOT called', async () => {
    m.consentService.check.mockResolvedValueOnce({
      result: 'denied',
      reason_code: 'stale_consent',
      decision_id: '00000000-0000-7000-8000-aaaa00000d01',
      computed_at: '2026-05-27T10:00:00.000Z',
    });
    try {
      await m.controller.sendOutreach(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID);
      throw new Error('expected throw');
    } catch (err) {
      const e = err as AramoError;
      expect(e.code).toBe('CONSENT_NOT_GRANTED_AT_SEND');
      expect(e.statusCode).toBe(403);
      const decision = e.context.details?.['consent_decision'] as { result: string; reason_code: string };
      expect(decision.reason_code).toBe('stale_consent');
    }
    expect(m.deliveryProvider.deliver).not.toHaveBeenCalled();
    expect(m.engagementRepo.sendOutreach).not.toHaveBeenCalled();
  });

  it('INTERNAL_ERROR 500 when consent resolver returns error result; delivery NOT called', async () => {
    m.consentService.check.mockResolvedValueOnce({
      result: 'error',
      decision_id: '00000000-0000-7000-8000-aaaa00000d02',
      computed_at: '2026-05-27T10:00:00.000Z',
    });
    await expect(
      m.controller.sendOutreach(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', statusCode: 500 });
    expect(m.deliveryProvider.deliver).not.toHaveBeenCalled();
  });

  it('ENGAGEMENT_STATE_INVALID 422 propagates from repository.sendOutreach', async () => {
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

  it('idempotency replay: returns prior body; delivery + repo NOT called', async () => {
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
    expect(m.deliveryProvider.deliver).not.toHaveBeenCalled();
    expect(m.engagementRepo.sendOutreach).not.toHaveBeenCalled();
    expect(m.idempotency.persist).not.toHaveBeenCalled();
  });
});

// M5 PR-7 §4.12 — EngagementController.recordResponse unit tests.
describe('EngagementController.recordResponse (M5 PR-7 unit)', () => {
  let m: ReturnType<typeof makeMocks>;
  const OUTREACH_REF_ID = '00000000-0000-7000-8000-eeee0e000001';
  const RESPONSE_EVENT_ID = '00000000-0000-7000-8000-eeee0e000002';
  const TRANSITION_EVENT_ID = '00000000-0000-7000-8000-eeee0e000003';
  const RESPONSE_RECEIVED_AT = '2026-05-25T11:00:00.000Z';

  const body: RecordResponseRequestDto = {
    response_received_at: RESPONSE_RECEIVED_AT,
    outreach_event_ref_id: OUTREACH_REF_ID,
  };

  const repoResultFixture = {
    engagement: makeEngagementView({ state: 'responded' }),
    response_event: {
      id: RESPONSE_EVENT_ID,
      tenant_id: TENANT_A,
      engagement_id: ENGAGEMENT_1,
      event_type: 'response_received',
      event_payload: {
        response_received_at: RESPONSE_RECEIVED_AT,
        recorded_by_user_id: RECRUITER_SUB,
        outreach_event_ref_id: OUTREACH_REF_ID,
      },
      created_at: new Date('2026-05-25T11:00:01.000Z'),
    },
    transition_event: {
      id: TRANSITION_EVENT_ID,
      tenant_id: TENANT_A,
      engagement_id: ENGAGEMENT_1,
      event_type: 'state_transition',
      event_payload: { from_state: 'awaiting_response', to_state: 'responded' },
      created_at: new Date('2026-05-25T11:00:01.000Z'),
    },
  };

  beforeEach(() => {
    m = makeMocks();
  });

  it('happy: 200 + repository.recordResponse called + idempotency.persist called', async () => {
    m.engagementRepo.recordResponse.mockResolvedValue(repoResultFixture);
    const res = await m.controller.recordResponse(
      ENGAGEMENT_1,
      body,
      VALID_IDEM_KEY,
      recruiterAuthContext(),
      REQUEST_ID,
    );
    expect(res.engagement.state).toBe('responded');
    expect(res.response_event.event_type).toBe('response_received');
    expect(m.engagementRepo.recordResponse).toHaveBeenCalledTimes(1);
    expect(m.idempotency.persist).toHaveBeenCalledTimes(1);
    // transition_event is NOT in the response per PR-7 §4.1 step 7.
    expect((res as Record<string, unknown>)['transition_event']).toBeUndefined();
    // No AI / delivery invocation on PR-7 path.
    expect(m.aiDraftService.generateDraft).not.toHaveBeenCalled();
    expect(m.deliveryProvider.deliver).not.toHaveBeenCalled();
  });

  it('INSUFFICIENT_PERMISSIONS 403 on portal consumer; repository NOT called', async () => {
    await expect(
      m.controller.recordResponse(ENGAGEMENT_1, body, VALID_IDEM_KEY, portalAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    expect(m.engagementRepo.recordResponse).not.toHaveBeenCalled();
  });

  it('VALIDATION_ERROR 400 on missing Idempotency-Key', async () => {
    await expect(
      m.controller.recordResponse(ENGAGEMENT_1, body, undefined, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    expect(m.engagementRepo.recordResponse).not.toHaveBeenCalled();
  });

  it('NOT_FOUND 404 propagates with requestId re-binding', async () => {
    m.engagementRepo.recordResponse.mockRejectedValue(
      new AramoError('NOT_FOUND', 'TalentJobEngagement not found', 404, {
        requestId: 'engagement-record-response',
        details: { engagement_id: ENGAGEMENT_1 },
      }),
    );
    try {
      await m.controller.recordResponse(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID);
      throw new Error('expected throw');
    } catch (err) {
      const e = err as AramoError;
      expect(e.code).toBe('NOT_FOUND');
      expect(e.statusCode).toBe(404);
      expect(e.context.requestId).toBe(REQUEST_ID);
    }
  });

  it('ENGAGEMENT_STATE_INVALID 422 propagates (e.g., engagement already in responded)', async () => {
    m.engagementRepo.recordResponse.mockRejectedValue(
      new AramoError('ENGAGEMENT_STATE_INVALID', 'illegal transition', 422, {
        requestId: 'engagement-record-response',
        details: { from_state: 'responded', to_state: 'responded' },
      }),
    );
    await expect(
      m.controller.recordResponse(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'ENGAGEMENT_STATE_INVALID', statusCode: 422 });
  });

  it('ENGAGEMENT_REFERENCE_NOT_FOUND 422 propagates (cross-event ref refusal)', async () => {
    m.engagementRepo.recordResponse.mockRejectedValue(
      new AramoError(
        'ENGAGEMENT_REFERENCE_NOT_FOUND',
        'outreach_event_ref_id not found, not in tenant, or not an outreach_sent event',
        422,
        {
          requestId: 'engagement-record-response',
          details: { field: 'outreach_event_ref_id' },
        },
      ),
    );
    try {
      await m.controller.recordResponse(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID);
      throw new Error('expected throw');
    } catch (err) {
      const e = err as AramoError;
      expect(e.code).toBe('ENGAGEMENT_REFERENCE_NOT_FOUND');
      expect(e.statusCode).toBe(422);
      expect(e.context.details?.['field']).toBe('outreach_event_ref_id');
    }
  });

  it('IDEMPOTENCY_KEY_CONFLICT 409 propagates from idempotency.lookup; repository NOT called', async () => {
    m.idempotency.lookup.mockRejectedValue(
      new AramoError('IDEMPOTENCY_KEY_CONFLICT', 'collision', 409, { requestId: REQUEST_ID }),
    );
    await expect(
      m.controller.recordResponse(ENGAGEMENT_1, body, VALID_IDEM_KEY, recruiterAuthContext(), REQUEST_ID),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT', statusCode: 409 });
    expect(m.engagementRepo.recordResponse).not.toHaveBeenCalled();
  });

  it('idempotency replay: lookup returns prior body; repository NOT called', async () => {
    const priorResponse = {
      engagement: makeEngagementView({ state: 'responded' }),
      response_event: repoResultFixture.response_event,
    };
    m.idempotency.lookup.mockResolvedValue({
      kind: 'replay',
      response_status: 200,
      response_body: priorResponse,
    });
    const res = await m.controller.recordResponse(
      ENGAGEMENT_1,
      body,
      VALID_IDEM_KEY,
      recruiterAuthContext(),
      REQUEST_ID,
    );
    expect(res).toBe(priorResponse);
    expect(m.engagementRepo.recordResponse).not.toHaveBeenCalled();
    expect(m.idempotency.persist).not.toHaveBeenCalled();
  });
});

// M5 PR-8a §4.12 — EngagementController.recordConversationStarted unit tests.
describe('EngagementController.recordConversationStarted (M5 PR-8a unit)', () => {
  let m: ReturnType<typeof makeMocks>;
  const CONVERSATION_EVENT_ID = '00000000-0000-7000-8000-cccc0e000001';
  const TRANSITION_EVENT_ID = '00000000-0000-7000-8000-cccc0e000002';
  const CONVERSATION_STARTED_AT = '2026-05-25T12:00:00.000Z';

  const body: RecordConversationStartedRequestDto = {
    conversation_started_at: CONVERSATION_STARTED_AT,
  };

  const repoResultFixture = {
    engagement: makeEngagementView({ state: 'in_conversation' }),
    conversation_event: {
      id: CONVERSATION_EVENT_ID,
      tenant_id: TENANT_A,
      engagement_id: ENGAGEMENT_1,
      event_type: 'conversation_started',
      event_payload: {
        conversation_started_at: CONVERSATION_STARTED_AT,
        recorded_by_user_id: RECRUITER_SUB,
      },
      created_at: new Date('2026-05-25T12:00:01.000Z'),
    },
    transition_event: {
      id: TRANSITION_EVENT_ID,
      tenant_id: TENANT_A,
      engagement_id: ENGAGEMENT_1,
      event_type: 'state_transition',
      event_payload: { from_state: 'responded', to_state: 'in_conversation' },
      created_at: new Date('2026-05-25T12:00:01.000Z'),
    },
  };

  beforeEach(() => {
    m = makeMocks();
  });

  it('happy: 200 + repository.recordConversationStarted called + idempotency.persist called', async () => {
    m.engagementRepo.recordConversationStarted.mockResolvedValue(repoResultFixture);
    const res = await m.controller.recordConversationStarted(
      ENGAGEMENT_1,
      body,
      VALID_IDEM_KEY,
      recruiterAuthContext(),
      REQUEST_ID,
    );
    expect(res.engagement.state).toBe('in_conversation');
    expect(res.conversation_event.event_type).toBe('conversation_started');
    expect(m.engagementRepo.recordConversationStarted).toHaveBeenCalledTimes(1);
    expect(m.idempotency.persist).toHaveBeenCalledTimes(1);
    // transition_event is NOT in the response per PR-8a §4.1 step 7.
    expect((res as Record<string, unknown>)['transition_event']).toBeUndefined();
    // No AI / delivery invocation on PR-8a path.
    expect(m.aiDraftService.generateDraft).not.toHaveBeenCalled();
    expect(m.deliveryProvider.deliver).not.toHaveBeenCalled();
  });

  it('INSUFFICIENT_PERMISSIONS 403 on portal consumer; repository NOT called', async () => {
    await expect(
      m.controller.recordConversationStarted(
        ENGAGEMENT_1,
        body,
        VALID_IDEM_KEY,
        portalAuthContext(),
        REQUEST_ID,
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    expect(m.engagementRepo.recordConversationStarted).not.toHaveBeenCalled();
  });

  it('VALIDATION_ERROR 400 on missing Idempotency-Key', async () => {
    await expect(
      m.controller.recordConversationStarted(
        ENGAGEMENT_1,
        body,
        undefined,
        recruiterAuthContext(),
        REQUEST_ID,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    expect(m.engagementRepo.recordConversationStarted).not.toHaveBeenCalled();
  });

  it('NOT_FOUND 404 propagates with requestId re-binding', async () => {
    m.engagementRepo.recordConversationStarted.mockRejectedValue(
      new AramoError('NOT_FOUND', 'TalentJobEngagement not found', 404, {
        requestId: 'engagement-record-conversation-started',
        details: { engagement_id: ENGAGEMENT_1 },
      }),
    );
    try {
      await m.controller.recordConversationStarted(
        ENGAGEMENT_1,
        body,
        VALID_IDEM_KEY,
        recruiterAuthContext(),
        REQUEST_ID,
      );
      throw new Error('expected throw');
    } catch (err) {
      const e = err as AramoError;
      expect(e.code).toBe('NOT_FOUND');
      expect(e.statusCode).toBe(404);
      expect(e.context.requestId).toBe(REQUEST_ID);
    }
  });

  it('ENGAGEMENT_STATE_INVALID 422 propagates (covers both illegal-state + natural-key dedup)', async () => {
    m.engagementRepo.recordConversationStarted.mockRejectedValue(
      new AramoError('ENGAGEMENT_STATE_INVALID', 'illegal transition', 422, {
        requestId: 'engagement-record-conversation-started',
        details: { from_state: 'in_conversation', to_state: 'in_conversation' },
      }),
    );
    await expect(
      m.controller.recordConversationStarted(
        ENGAGEMENT_1,
        body,
        VALID_IDEM_KEY,
        recruiterAuthContext(),
        REQUEST_ID,
      ),
    ).rejects.toMatchObject({ code: 'ENGAGEMENT_STATE_INVALID', statusCode: 422 });
  });

  it('IDEMPOTENCY_KEY_CONFLICT 409 propagates from idempotency.lookup; repository NOT called', async () => {
    m.idempotency.lookup.mockRejectedValue(
      new AramoError('IDEMPOTENCY_KEY_CONFLICT', 'collision', 409, { requestId: REQUEST_ID }),
    );
    await expect(
      m.controller.recordConversationStarted(
        ENGAGEMENT_1,
        body,
        VALID_IDEM_KEY,
        recruiterAuthContext(),
        REQUEST_ID,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT', statusCode: 409 });
    expect(m.engagementRepo.recordConversationStarted).not.toHaveBeenCalled();
  });

  it('idempotency replay: lookup returns prior body; repository NOT called', async () => {
    const priorResponse = {
      engagement: makeEngagementView({ state: 'in_conversation' }),
      conversation_event: repoResultFixture.conversation_event,
    };
    m.idempotency.lookup.mockResolvedValue({
      kind: 'replay',
      response_status: 200,
      response_body: priorResponse,
    });
    const res = await m.controller.recordConversationStarted(
      ENGAGEMENT_1,
      body,
      VALID_IDEM_KEY,
      recruiterAuthContext(),
      REQUEST_ID,
    );
    expect(res).toBe(priorResponse);
    expect(m.engagementRepo.recordConversationStarted).not.toHaveBeenCalled();
    expect(m.idempotency.persist).not.toHaveBeenCalled();
  });
});

// =========================================================================
// R7 BE-prereq — P1 (LIST) + P3 (D4b visibility) proofs.
//
// The P2 scope-gate proofs live at the RolesGuard layer (the @RequireScopes
// decorators), tested in apps/api integration tests where the guard fires
// (the unit-level controller spec calls handlers directly, bypassing the
// guard). The unit-level proofs cover the controller logic:
//   - listEngagements dispatches to the correct repo method by filter shape.
//   - assertRequisitionVisible fires 404 on create when the requisition is
//     invisible.
//   - The mutate-existing endpoints (transitions/response/conversation/
//     outreach) thread visible_requisition_ids through to the repo.
// =========================================================================

// Mock Request shape — a recruiter with a NARROW visible-requisition set
// (the engagement's requisition is in the set ⇒ visible; not in ⇒ 404).
function reqWithVisibleReqs(
  ...reqIds: string[]
): { resolveVisibleRequisitionIds: () => Promise<ReadonlySet<string>> } {
  return {
    resolveVisibleRequisitionIds: () =>
      Promise.resolve(new Set<string>(reqIds)),
  };
}

// Empty visible set — invisible-to-the-actor everything.
function reqWithNoVisibleReqs(): {
  resolveVisibleRequisitionIds: () => Promise<ReadonlySet<string>>;
} {
  return {
    resolveVisibleRequisitionIds: () => Promise.resolve(new Set<string>()),
  };
}

describe('EngagementController.listEngagements (R7 BE-prereq P1 unit)', () => {
  let m: ReturnType<typeof makeMocks>;
  beforeEach(() => {
    m = makeMocks();
    // Add the new findByTenant / findByTenantAndTalent / findByTenantAndRequisition
    // mock methods used by the LIST dispatcher.
    (m.engagementRepo as unknown as Record<string, unknown>)['findByTenant'] =
      vi.fn().mockResolvedValue([makeEngagementView()]);
    (m.engagementRepo as unknown as Record<string, unknown>)['findByTenantAndTalent'] =
      vi.fn().mockResolvedValue([makeEngagementView()]);
    (m.engagementRepo as unknown as Record<string, unknown>)['findByTenantAndRequisition'] =
      vi.fn().mockResolvedValue([makeEngagementView()]);
  });

  it('no-filter LIST dispatches to findByTenant with the visible set', async () => {
    const res = await m.controller.listEngagements(
      recruiterAuthContext(),
      undefined,
      undefined,
      REQUEST_ID,
      reqWithVisibleReqs(REQ_A) as never,
    );
    expect(res.items).toHaveLength(1);
    const repo = m.engagementRepo as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(repo['findByTenant']).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TENANT_A,
        visible_requisition_ids: expect.any(Set),
      }),
    );
  });

  it('?talent_id LIST dispatches to findByTenantAndTalent', async () => {
    await m.controller.listEngagements(
      recruiterAuthContext(),
      TALENT_A,
      undefined,
      REQUEST_ID,
      reqWithVisibleReqs(REQ_A) as never,
    );
    const repo = m.engagementRepo as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(repo['findByTenantAndTalent']).toHaveBeenCalledWith(
      expect.objectContaining({ talent_id: TALENT_A }),
    );
    expect(repo['findByTenant']).not.toHaveBeenCalled();
  });

  it('?requisition_id LIST dispatches to findByTenantAndRequisition', async () => {
    await m.controller.listEngagements(
      recruiterAuthContext(),
      undefined,
      REQ_A,
      REQUEST_ID,
      reqWithVisibleReqs(REQ_A) as never,
    );
    const repo = m.engagementRepo as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(repo['findByTenantAndRequisition']).toHaveBeenCalledWith(
      expect.objectContaining({ requisition_id: REQ_A }),
    );
  });

  it('?talent_id&?requisition_id LIST narrows the requisition path by talent_id', async () => {
    const repo = m.engagementRepo as unknown as Record<string, ReturnType<typeof vi.fn>>;
    repo['findByTenantAndRequisition'].mockResolvedValue([
      makeEngagementView({ talent_id: TALENT_A }),
      makeEngagementView({
        id: 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee',
        talent_id: 'ffffffff-ffff-7fff-8fff-ffffffffffff',
      }),
    ]);
    const res = await m.controller.listEngagements(
      recruiterAuthContext(),
      TALENT_A,
      REQ_A,
      REQUEST_ID,
      reqWithVisibleReqs(REQ_A) as never,
    );
    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.talent_id).toBe(TALENT_A);
  });

  it('non-recruiter consumer 403s INSUFFICIENT_PERMISSIONS', async () => {
    await expect(
      m.controller.listEngagements(
        portalAuthContext(),
        undefined,
        undefined,
        REQUEST_ID,
        reqWithVisibleReqs(REQ_A) as never,
      ),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
    });
  });
});

describe('EngagementController D4b visibility composition (R7 BE-prereq P3 unit)', () => {
  let m: ReturnType<typeof makeMocks>;
  beforeEach(() => {
    m = makeMocks();
  });

  it('create with invisible requisition_id → 404 NOT_FOUND (assertRequisitionVisible)', async () => {
    // body.requisition_id = REQ_A; but the actor's visible set does NOT
    // contain REQ_A — 404 fires before any repo call.
    const body: CreateEngagementRequestDto = {
      talent_id: TALENT_A,
      requisition_id: REQ_A,
      examination_id: EXAM_A,
    };
    await expect(
      m.controller.createEngagement(
        body,
        VALID_IDEM_KEY,
        recruiterAuthContext(),
        REQUEST_ID,
        reqWithNoVisibleReqs() as never,
      ),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
    expect(m.engagementRepo.createEngagement).not.toHaveBeenCalled();
  });

  it('create with visible requisition_id → proceeds to repo.createEngagement', async () => {
    const body: CreateEngagementRequestDto = {
      talent_id: TALENT_A,
      requisition_id: REQ_A,
      examination_id: EXAM_A,
    };
    m.engagementRepo.createEngagement.mockResolvedValue({
      engagement: makeEngagementView(),
      event: { id: EVENT_1 },
    });
    await m.controller.createEngagement(
      body,
      VALID_IDEM_KEY,
      recruiterAuthContext(),
      REQUEST_ID,
      reqWithVisibleReqs(REQ_A) as never,
    );
    expect(m.engagementRepo.createEngagement).toHaveBeenCalled();
  });

  it('see-all (req=undefined back-compat) → no visibility filter applied; create proceeds', async () => {
    // Existing tests that don't pass req still work — null visible set
    // = see-all per the resolveVisibleReqIds helper.
    const body: CreateEngagementRequestDto = {
      talent_id: TALENT_A,
      requisition_id: REQ_A,
      examination_id: EXAM_A,
    };
    m.engagementRepo.createEngagement.mockResolvedValue({
      engagement: makeEngagementView(),
      event: { id: EVENT_1 },
    });
    // No req arg — undefined.
    await m.controller.createEngagement(
      body,
      VALID_IDEM_KEY,
      recruiterAuthContext(),
      REQUEST_ID,
    );
    expect(m.engagementRepo.createEngagement).toHaveBeenCalled();
  });

  it('transitions threads visible_requisition_ids to repo.transitionState', async () => {
    m.engagementRepo.transitionState.mockResolvedValue({
      engagement: makeEngagementView({ state: 'evaluated' }),
      event: { id: EVENT_1 },
    });
    await m.controller.transitionEngagement(
      ENGAGEMENT_1,
      { event_id: EVENT_1, to_state: 'evaluated' } as TransitionEngagementRequestDto,
      VALID_IDEM_KEY,
      recruiterAuthContext(),
      REQUEST_ID,
      reqWithVisibleReqs(REQ_A) as never,
    );
    expect(m.engagementRepo.transitionState).toHaveBeenCalledWith(
      expect.objectContaining({
        engagement_id: ENGAGEMENT_1,
        visible_requisition_ids: expect.any(Set),
      }),
    );
  });

  it('GET /:id with invisible requisition → 404 via repo.findByTenantAndId(null)', async () => {
    // Simulate the repo returning null (the D4b composition matched
    // requisition not in set → null projection).
    m.engagementRepo.findByTenantAndId.mockResolvedValueOnce(null);
    await expect(
      m.controller.getEngagement(
        ENGAGEMENT_1,
        recruiterAuthContext(),
        REQUEST_ID,
        reqWithNoVisibleReqs() as never,
      ),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
  });
});
