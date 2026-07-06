import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  ISO_TIMESTAMP,
  TALENT_ID,
  TENANT_ID,
  errorBody,
  like,
  makeAtsWebProvider,
  regex,
  uuid,
} from './support/ats-web-pact.js';

// PC-1 — Pact consumer for ats-web (the live recruiter SPA), engagement
// domain. PC-2: retrofitted onto the shared support module (ctor factory +
// shared constants + generic errorBody); domain views/constants stay here.
//
// Consumer:  ats-web     (browser/SPA; the only live FE — Lead ruling R1)
// Provider:  aramo-core  (apps/api)
//
// Scope (PC-1 Directive §2.3): the engagement endpoints ats-web's
// apiClient wrapper (apps/ats-web/src/engagement/engagement-api.ts)
// actually calls — 8 of the 9 live endpoints. Per endpoint, R7 discipline:
//   - happy path (request/response derived from the FE call site + the
//     live controller DTOs, NOT the retired ats-thin files);
//   - illegal-state 422 ENGAGEMENT_STATE_INVALID (the state machine is
//     live + settled: libs/engagement/src/lib/engagement-state.ts);
//   - idempotency replay + conflict pair for each POST requiring an
//     Idempotency-Key (M5 PR-9 Ruling 2 naming);
//   - refusal (PC-1 Gate-6 Lead amendment — the named 4th PC class):
//     pin what an endpoint guarantees, not only what the FE exercises.
//     CONSENT_NOT_GRANTED_AT_SEND (403) at send; ENGAGEMENT_REFERENCE_
//     NOT_FOUND (422) at send (draft_event_id) + response
//     (outreach_event_ref_id).
//
// EXCLUDED (Directive §2.3 / R2 — demand gate is endpoint-level):
//   - POST /v1/engagements (create) — ats-web has NO call site for it
//     (engagements are minted server-side via other flows, not the
//     composer). engagement-api.ts exposes list/get/events + transitions/
//     response/conversation/outreach-draft/outreach-send only.
//
// Faithful-display discipline: every response shape here is restricted to
// the fields the live *.dto.ts / *.view.ts define (TalentJobEngagementView,
// TalentEngagementEventView, Outreach{Draft,Send}ResponseDto, etc.).
//
// Auth: the fake `aramo_access_token` cookie is rewritten to the real
// recruiter JWT by the provider requestFilter (verify-api.ts) — same
// posture as tenant-console-consumer.

const provider = makeAtsWebProvider();

// ---- engagement-domain constant (shared ones come from the support module)
const REQUISITION_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';

// Engagement fixtures, one id per seeded state (see verify-api.ts PC-1
// state handlers).
const SURFACED_ID = '00000000-0000-7000-8000-a00000000001';
const AWAITING_ID = '00000000-0000-7000-8000-a00000000002';
const RESPONDED_ID = '00000000-0000-7000-8000-a00000000003';
const ENGAGED_ID = '00000000-0000-7000-8000-a00000000004';
const ENGAGED_DRAFT_ID = '00000000-0000-7000-8000-a00000000005';
const ENGAGED_SEND_ID = '00000000-0000-7000-8000-a00000000006';
const EVENTS_ID = '00000000-0000-7000-8000-a00000000007';
// engaged + drafted event but contacting NOT granted (send consent-403).
const ENGAGED_SEND_NO_CONSENT_ID = '00000000-0000-7000-8000-a00000000008';

// Referenced event ids (seeded on the provider side).
const OUTREACH_SENT_EVENT_ID = '00000000-0000-7000-8000-b00000000001';
const OUTREACH_DRAFTED_EVENT_ID = '00000000-0000-7000-8000-b00000000003';
// Deliberately-unresolvable references (refusal interactions).
const NONEXISTENT_DRAFT_REF = '00000000-0000-7000-8000-b0000000fffd';
const NONEXISTENT_OUTREACH_REF = '00000000-0000-7000-8000-b0000000fffe';

// Idempotency keys (UUID-shaped per assertIdempotencyKeyRequired).
const K_TRANSITION_REPLAY = '00000000-0000-7000-8000-d00000000101';
const K_TRANSITION_CONFLICT = '00000000-0000-7000-8000-d00000000102';
const K_RESPONSE_REPLAY = '00000000-0000-7000-8000-d00000000201';
const K_RESPONSE_CONFLICT = '00000000-0000-7000-8000-d00000000202';
const K_CONVERSATION_REPLAY = '00000000-0000-7000-8000-d00000000301';
const K_CONVERSATION_CONFLICT = '00000000-0000-7000-8000-d00000000302';
const K_DRAFT_REPLAY = '00000000-0000-7000-8000-d00000000401';
const K_DRAFT_CONFLICT = '00000000-0000-7000-8000-d00000000402';
const K_SEND_REPLAY = '00000000-0000-7000-8000-d00000000501';
const K_SEND_CONFLICT = '00000000-0000-7000-8000-d00000000502';

// event_id supplied by the transition caller (state-keyed per FE ruling).
const TRANSITION_EVENT_ID = '00000000-0000-7000-8000-e00000000001';

// ISO_TIMESTAMP now imported from the support module.

// Engagement-domain response-shape builders (stay in the domain file).
function engagementView(id: string, state: string) {
  return {
    id: uuid(id),
    tenant_id: uuid(TENANT_ID),
    talent_id: uuid(TALENT_ID),
    requisition_id: uuid(REQUISITION_ID),
    examination_id: null,
    state,
    created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
  };
}

function eventView(engagementId: string, eventType: string) {
  return {
    id: uuid(),
    tenant_id: uuid(TENANT_ID),
    engagement_id: uuid(engagementId),
    event_type: eventType,
    event_payload: like({}),
    created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
  };
}

// Engagement-domain error aliases — thin semantic wrappers over the shared
// errorBody (same code + message example → byte-identical pact output).
function stateInvalidError() {
  return errorBody('ENGAGEMENT_STATE_INVALID', 'Illegal engagement state transition');
}

function idempotencyConflictError() {
  return errorBody('IDEMPOTENCY_KEY_CONFLICT', 'Idempotency-Key conflict');
}

function consentNotGrantedError() {
  return errorBody('CONSENT_NOT_GRANTED_AT_SEND', 'consent denied at send time');
}

function referenceNotFoundError() {
  return errorBody('ENGAGEMENT_REFERENCE_NOT_FOUND', 'reference not found');
}

// ======================================================================
// GET /v1/engagements?talent_id= — happy
// ======================================================================
describe('ats-web → GET /v1/engagements', () => {
  it('returns 200 with the talent\'s visible engagements', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an engagement in surfaced state exist for the talent')
      .uponReceiving('a list engagements read filtered by talent_id')
      .withRequest('GET', `/v1/engagements`, (b) => {
        b.query({ talent_id: TALENT_ID }).headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: [engagementView(SURFACED_ID, 'surfaced')] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/engagements?talent_id=${encodeURIComponent(TALENT_ID)}`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: Array<{ id: string }> };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });
});

// ======================================================================
// GET /v1/engagements/:id — happy
// ======================================================================
describe('ats-web → GET /v1/engagements/:id', () => {
  it('returns 200 with the engagement view', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an engagement in surfaced state exist for the talent')
      .uponReceiving('a single engagement read by id')
      .withRequest('GET', `/v1/engagements/${SURFACED_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(engagementView(SURFACED_ID, 'surfaced'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${SURFACED_ID}`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { state: string };
        expect(body.state).toBe('surfaced');
      });
  });
});

// ======================================================================
// GET /v1/engagements/:id/events — happy
// ======================================================================
describe('ats-web → GET /v1/engagements/:id/events', () => {
  it('returns 200 with the engagement event log', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an engagement with a recorded event exist')
      .uponReceiving('an engagement event-log read')
      .withRequest('GET', `/v1/engagements/${EVENTS_ID}/events`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ events: [eventView(EVENTS_ID, 'outreach_sent')] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/engagements/${EVENTS_ID}/events`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { events: unknown[] };
        expect(body.events.length).toBeGreaterThan(0);
      });
  });
});

// ======================================================================
// POST /v1/engagements/:id/transitions — happy + illegal-state + idempotency
// ======================================================================
describe('ats-web → POST /v1/engagements/:id/transitions', () => {
  it('returns 200 and advances the engagement to the target state', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an engagement in surfaced state exist for the talent')
      .uponReceiving('a legal transition surfaced -> evaluated')
      .withRequest('POST', `/v1/engagements/${SURFACED_ID}/transitions`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid(TRANSITION_EVENT_ID),
          'Content-Type': 'application/json',
        }).jsonBody({ to_state: 'evaluated', event_id: uuid(TRANSITION_EVENT_ID) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ engagement: engagementView(SURFACED_ID, 'evaluated') });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/engagements/${SURFACED_ID}/transitions`,
          {
            method: 'POST',
            headers: {
              Cookie: ACCESS_COOKIE,
              'Idempotency-Key': TRANSITION_EVENT_ID,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ to_state: 'evaluated', event_id: TRANSITION_EVENT_ID }),
          },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { engagement: { state: string } };
        expect(body.engagement.state).toBe('evaluated');
      });
  });

  it('returns 422 ENGAGEMENT_STATE_INVALID for an illegal transition', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an engagement in surfaced state exist for the talent')
      .uponReceiving('an illegal transition surfaced -> engaged')
      .withRequest('POST', `/v1/engagements/${SURFACED_ID}/transitions`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid('00000000-0000-7000-8000-e00000000009'),
          'Content-Type': 'application/json',
        }).jsonBody({ to_state: 'engaged', event_id: uuid('00000000-0000-7000-8000-e00000000009') });
      })
      .willRespondWith(422, (b) => {
        b.jsonBody(stateInvalidError());
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/engagements/${SURFACED_ID}/transitions`,
          {
            method: 'POST',
            headers: {
              Cookie: ACCESS_COOKIE,
              'Idempotency-Key': '00000000-0000-7000-8000-e00000000009',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ to_state: 'engaged', event_id: '00000000-0000-7000-8000-e00000000009' }),
          },
        );
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('ENGAGEMENT_STATE_INVALID');
      });
  });

  it('transitions returns the cached response on Idempotency-Key replay', async () => {
    await provider
      .addInteraction()
      .given('a prior engagement-transition response is cached under an Idempotency-Key')
      .uponReceiving('a transition replay with the same Idempotency-Key and body')
      .withRequest('POST', `/v1/engagements/${SURFACED_ID}/transitions`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid(K_TRANSITION_REPLAY),
          'Content-Type': 'application/json',
        }).jsonBody({ to_state: 'evaluated', event_id: uuid(TRANSITION_EVENT_ID) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ engagement: engagementView(SURFACED_ID, 'evaluated') });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/engagements/${SURFACED_ID}/transitions`,
          {
            method: 'POST',
            headers: {
              Cookie: ACCESS_COOKIE,
              'Idempotency-Key': K_TRANSITION_REPLAY,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ to_state: 'evaluated', event_id: TRANSITION_EVENT_ID }),
          },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { engagement: { state: string } };
        expect(body.engagement.state).toBe('evaluated');
      });
  });

  it('transitions returns 409 IDEMPOTENCY_KEY_CONFLICT on a key reused with a different body', async () => {
    await provider
      .addInteraction()
      .given('an Idempotency-Key was used with a different engagement-transition body')
      .uponReceiving('a transition with a conflicting Idempotency-Key')
      .withRequest('POST', `/v1/engagements/${SURFACED_ID}/transitions`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid(K_TRANSITION_CONFLICT),
          'Content-Type': 'application/json',
        }).jsonBody({ to_state: 'evaluated', event_id: uuid(TRANSITION_EVENT_ID) });
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(idempotencyConflictError());
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/engagements/${SURFACED_ID}/transitions`,
          {
            method: 'POST',
            headers: {
              Cookie: ACCESS_COOKIE,
              'Idempotency-Key': K_TRANSITION_CONFLICT,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ to_state: 'evaluated', event_id: TRANSITION_EVENT_ID }),
          },
        );
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      });
  });
});

// ======================================================================
// POST /v1/engagements/:id/response — happy + illegal-state + idempotency
// ======================================================================
const RESPONSE_BODY = {
  response_received_at: '2026-05-25T11:00:00.000Z',
  outreach_event_ref_id: OUTREACH_SENT_EVENT_ID,
};

describe('ats-web → POST /v1/engagements/:id/response', () => {
  it('returns 200 with the advanced engagement + response_event', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an engagement in awaiting_response state with a prior outreach_sent event exist')
      .uponReceiving('a record-response for the talent')
      .withRequest('POST', `/v1/engagements/${AWAITING_ID}/response`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid('00000000-0000-7000-8000-e00000000021'),
          'Content-Type': 'application/json',
        }).jsonBody(RESPONSE_BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          engagement: engagementView(AWAITING_ID, 'responded'),
          response_event: eventView(AWAITING_ID, 'response_received'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${AWAITING_ID}/response`, {
          method: 'POST',
          headers: {
            Cookie: ACCESS_COOKIE,
            'Idempotency-Key': '00000000-0000-7000-8000-e00000000021',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(RESPONSE_BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { engagement: { state: string } };
        expect(body.engagement.state).toBe('responded');
      });
  });

  it('returns 422 ENGAGEMENT_STATE_INVALID when the engagement is not awaiting_response', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an engagement in responded state with a prior outreach_sent event exist')
      .uponReceiving('a record-response on an engagement past awaiting_response')
      .withRequest('POST', `/v1/engagements/${RESPONDED_ID}/response`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid('00000000-0000-7000-8000-e00000000022'),
          'Content-Type': 'application/json',
        }).jsonBody({
          response_received_at: '2026-05-25T11:00:00.000Z',
          outreach_event_ref_id: OUTREACH_SENT_EVENT_ID,
        });
      })
      .willRespondWith(422, (b) => {
        b.jsonBody(stateInvalidError());
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${RESPONDED_ID}/response`, {
          method: 'POST',
          headers: {
            Cookie: ACCESS_COOKIE,
            'Idempotency-Key': '00000000-0000-7000-8000-e00000000022',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            response_received_at: '2026-05-25T11:00:00.000Z',
            outreach_event_ref_id: OUTREACH_SENT_EVENT_ID,
          }),
        });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('ENGAGEMENT_STATE_INVALID');
      });
  });

  it('response returns the cached response on Idempotency-Key replay', async () => {
    await provider
      .addInteraction()
      .given('a prior response-received response is cached under an Idempotency-Key')
      .uponReceiving('a record-response replay with the same Idempotency-Key and body')
      .withRequest('POST', `/v1/engagements/${AWAITING_ID}/response`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid(K_RESPONSE_REPLAY),
          'Content-Type': 'application/json',
        }).jsonBody(RESPONSE_BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          engagement: engagementView(AWAITING_ID, 'responded'),
          response_event: eventView(AWAITING_ID, 'response_received'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${AWAITING_ID}/response`, {
          method: 'POST',
          headers: {
            Cookie: ACCESS_COOKIE,
            'Idempotency-Key': K_RESPONSE_REPLAY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(RESPONSE_BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { engagement: { state: string } };
        expect(body.engagement.state).toBe('responded');
      });
  });

  it('response returns 409 IDEMPOTENCY_KEY_CONFLICT on a key reused with a different body', async () => {
    await provider
      .addInteraction()
      .given('an Idempotency-Key was used with a different response-received body')
      .uponReceiving('a record-response with a conflicting Idempotency-Key')
      .withRequest('POST', `/v1/engagements/${AWAITING_ID}/response`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid(K_RESPONSE_CONFLICT),
          'Content-Type': 'application/json',
        }).jsonBody(RESPONSE_BODY);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(idempotencyConflictError());
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${AWAITING_ID}/response`, {
          method: 'POST',
          headers: {
            Cookie: ACCESS_COOKIE,
            'Idempotency-Key': K_RESPONSE_CONFLICT,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(RESPONSE_BODY),
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      });
  });

  it('returns 422 ENGAGEMENT_REFERENCE_NOT_FOUND when outreach_event_ref_id does not resolve', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an engagement in awaiting_response state with a prior outreach_sent event exist')
      .uponReceiving('a record-response referencing an unknown outreach_event_ref_id')
      .withRequest('POST', `/v1/engagements/${AWAITING_ID}/response`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid('00000000-0000-7000-8000-e00000000023'),
          'Content-Type': 'application/json',
        }).jsonBody({
          response_received_at: '2026-05-25T11:00:00.000Z',
          outreach_event_ref_id: NONEXISTENT_OUTREACH_REF,
        });
      })
      .willRespondWith(422, (b) => {
        b.jsonBody(referenceNotFoundError());
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${AWAITING_ID}/response`, {
          method: 'POST',
          headers: {
            Cookie: ACCESS_COOKIE,
            'Idempotency-Key': '00000000-0000-7000-8000-e00000000023',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            response_received_at: '2026-05-25T11:00:00.000Z',
            outreach_event_ref_id: NONEXISTENT_OUTREACH_REF,
          }),
        });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('ENGAGEMENT_REFERENCE_NOT_FOUND');
      });
  });
});

// ======================================================================
// POST /v1/engagements/:id/conversation — happy + illegal-state + idempotency
// ======================================================================
const CONVERSATION_BODY = { conversation_started_at: '2026-05-25T12:00:00.000Z' };

describe('ats-web → POST /v1/engagements/:id/conversation', () => {
  it('returns 200 with the advanced engagement + conversation_event', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an engagement in responded state with a prior outreach_sent event exist')
      .uponReceiving('a record-conversation-started for the talent')
      .withRequest('POST', `/v1/engagements/${RESPONDED_ID}/conversation`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid('00000000-0000-7000-8000-e00000000031'),
          'Content-Type': 'application/json',
        }).jsonBody(CONVERSATION_BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          engagement: engagementView(RESPONDED_ID, 'in_conversation'),
          conversation_event: eventView(RESPONDED_ID, 'conversation_started'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${RESPONDED_ID}/conversation`, {
          method: 'POST',
          headers: {
            Cookie: ACCESS_COOKIE,
            'Idempotency-Key': '00000000-0000-7000-8000-e00000000031',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(CONVERSATION_BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { engagement: { state: string } };
        expect(body.engagement.state).toBe('in_conversation');
      });
  });

  it('returns 422 ENGAGEMENT_STATE_INVALID when the engagement is not responded', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an engagement in engaged state exist')
      .uponReceiving('a record-conversation-started on an engagement not in responded')
      .withRequest('POST', `/v1/engagements/${ENGAGED_ID}/conversation`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid('00000000-0000-7000-8000-e00000000032'),
          'Content-Type': 'application/json',
        }).jsonBody(CONVERSATION_BODY);
      })
      .willRespondWith(422, (b) => {
        b.jsonBody(stateInvalidError());
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGED_ID}/conversation`, {
          method: 'POST',
          headers: {
            Cookie: ACCESS_COOKIE,
            'Idempotency-Key': '00000000-0000-7000-8000-e00000000032',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(CONVERSATION_BODY),
        });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('ENGAGEMENT_STATE_INVALID');
      });
  });

  it('conversation returns the cached response on Idempotency-Key replay', async () => {
    await provider
      .addInteraction()
      .given('a prior conversation-started response is cached under an Idempotency-Key')
      .uponReceiving('a record-conversation-started replay with the same Idempotency-Key and body')
      .withRequest('POST', `/v1/engagements/${RESPONDED_ID}/conversation`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid(K_CONVERSATION_REPLAY),
          'Content-Type': 'application/json',
        }).jsonBody(CONVERSATION_BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          engagement: engagementView(RESPONDED_ID, 'in_conversation'),
          conversation_event: eventView(RESPONDED_ID, 'conversation_started'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${RESPONDED_ID}/conversation`, {
          method: 'POST',
          headers: {
            Cookie: ACCESS_COOKIE,
            'Idempotency-Key': K_CONVERSATION_REPLAY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(CONVERSATION_BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { engagement: { state: string } };
        expect(body.engagement.state).toBe('in_conversation');
      });
  });

  it('conversation returns 409 IDEMPOTENCY_KEY_CONFLICT on a key reused with a different body', async () => {
    await provider
      .addInteraction()
      .given('an Idempotency-Key was used with a different conversation-started body')
      .uponReceiving('a record-conversation-started with a conflicting Idempotency-Key')
      .withRequest('POST', `/v1/engagements/${RESPONDED_ID}/conversation`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid(K_CONVERSATION_CONFLICT),
          'Content-Type': 'application/json',
        }).jsonBody(CONVERSATION_BODY);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(idempotencyConflictError());
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${RESPONDED_ID}/conversation`, {
          method: 'POST',
          headers: {
            Cookie: ACCESS_COOKIE,
            'Idempotency-Key': K_CONVERSATION_CONFLICT,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(CONVERSATION_BODY),
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      });
  });
});

// ======================================================================
// POST /v1/engagements/:id/outreach/draft — happy + illegal-state + idempotency
// ======================================================================
const DRAFT_BODY = { prompt: 'Reach out to the talent about the role.' };

function draftResponse() {
  return {
    draft_event_id: uuid(),
    draft_text: like('Mocked outreach draft for pact verification.'),
    ai_draft_audit_record_id: uuid(),
  };
}

describe('ats-web → POST /v1/engagements/:id/outreach/draft', () => {
  it('returns 200 with the generated draft', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an engagement in engaged state with contacting consent granted exist')
      .uponReceiving('an outreach draft generation')
      .withRequest('POST', `/v1/engagements/${ENGAGED_DRAFT_ID}/outreach/draft`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid('00000000-0000-7000-8000-e00000000041'),
          'Content-Type': 'application/json',
        }).jsonBody(DRAFT_BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(draftResponse());
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/engagements/${ENGAGED_DRAFT_ID}/outreach/draft`,
          {
            method: 'POST',
            headers: {
              Cookie: ACCESS_COOKIE,
              'Idempotency-Key': '00000000-0000-7000-8000-e00000000041',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(DRAFT_BODY),
          },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { draft_event_id: string; draft_text: string };
        expect(body.draft_text.length).toBeGreaterThan(0);
      });
  });

  it('returns 422 ENGAGEMENT_STATE_INVALID when the engagement cannot reach awaiting_response', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an engagement in surfaced state exist for the talent')
      .uponReceiving('an outreach draft on an engagement that cannot be contacted')
      .withRequest('POST', `/v1/engagements/${SURFACED_ID}/outreach/draft`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid('00000000-0000-7000-8000-e00000000042'),
          'Content-Type': 'application/json',
        }).jsonBody(DRAFT_BODY);
      })
      .willRespondWith(422, (b) => {
        b.jsonBody(stateInvalidError());
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/engagements/${SURFACED_ID}/outreach/draft`,
          {
            method: 'POST',
            headers: {
              Cookie: ACCESS_COOKIE,
              'Idempotency-Key': '00000000-0000-7000-8000-e00000000042',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(DRAFT_BODY),
          },
        );
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('ENGAGEMENT_STATE_INVALID');
      });
  });

  it('draft returns the cached response on Idempotency-Key replay', async () => {
    await provider
      .addInteraction()
      .given('a prior outreach-draft response is cached under an Idempotency-Key')
      .uponReceiving('an outreach draft replay with the same Idempotency-Key and body')
      .withRequest('POST', `/v1/engagements/${ENGAGED_DRAFT_ID}/outreach/draft`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid(K_DRAFT_REPLAY),
          'Content-Type': 'application/json',
        }).jsonBody(DRAFT_BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(draftResponse());
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/engagements/${ENGAGED_DRAFT_ID}/outreach/draft`,
          {
            method: 'POST',
            headers: {
              Cookie: ACCESS_COOKIE,
              'Idempotency-Key': K_DRAFT_REPLAY,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(DRAFT_BODY),
          },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { draft_event_id: string };
        expect(body.draft_event_id).toBeTruthy();
      });
  });

  it('draft returns 409 IDEMPOTENCY_KEY_CONFLICT on a key reused with a different body', async () => {
    await provider
      .addInteraction()
      .given('an Idempotency-Key was used with a different outreach-draft body')
      .uponReceiving('an outreach draft with a conflicting Idempotency-Key')
      .withRequest('POST', `/v1/engagements/${ENGAGED_DRAFT_ID}/outreach/draft`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid(K_DRAFT_CONFLICT),
          'Content-Type': 'application/json',
        }).jsonBody(DRAFT_BODY);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(idempotencyConflictError());
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/engagements/${ENGAGED_DRAFT_ID}/outreach/draft`,
          {
            method: 'POST',
            headers: {
              Cookie: ACCESS_COOKIE,
              'Idempotency-Key': K_DRAFT_CONFLICT,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(DRAFT_BODY),
          },
        );
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      });
  });
});

// ======================================================================
// POST /v1/engagements/:id/outreach/send — happy + illegal-state + idempotency
// ======================================================================
const SEND_BODY = {
  draft_event_id: OUTREACH_DRAFTED_EVENT_ID,
  final_text: 'Hello — we have a role that matches your background.',
};

function sendResponse() {
  return {
    engagement: engagementView(ENGAGED_SEND_ID, 'awaiting_response'),
    outreach_event: eventView(ENGAGED_SEND_ID, 'outreach_sent'),
    delivery_id: uuid(),
  };
}

describe('ats-web → POST /v1/engagements/:id/outreach/send', () => {
  it('returns 200 with the advanced engagement + outreach_sent event + delivery_id', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an engagement in engaged state with a prior outreach_drafted event and contacting consent granted exist')
      .uponReceiving('an outreach send from an approved draft')
      .withRequest('POST', `/v1/engagements/${ENGAGED_SEND_ID}/outreach/send`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid('00000000-0000-7000-8000-e00000000051'),
          'Content-Type': 'application/json',
        }).jsonBody(SEND_BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(sendResponse());
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/engagements/${ENGAGED_SEND_ID}/outreach/send`,
          {
            method: 'POST',
            headers: {
              Cookie: ACCESS_COOKIE,
              'Idempotency-Key': '00000000-0000-7000-8000-e00000000051',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(SEND_BODY),
          },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { engagement: { state: string }; delivery_id: string };
        expect(body.engagement.state).toBe('awaiting_response');
        expect(body.delivery_id).toBeTruthy();
      });
  });

  it('returns 422 ENGAGEMENT_STATE_INVALID when the engagement cannot reach awaiting_response', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an engagement in surfaced state exist for the talent')
      .uponReceiving('an outreach send on an engagement that cannot be contacted')
      .withRequest('POST', `/v1/engagements/${SURFACED_ID}/outreach/send`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid('00000000-0000-7000-8000-e00000000052'),
          'Content-Type': 'application/json',
        }).jsonBody(SEND_BODY);
      })
      .willRespondWith(422, (b) => {
        b.jsonBody(stateInvalidError());
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/engagements/${SURFACED_ID}/outreach/send`,
          {
            method: 'POST',
            headers: {
              Cookie: ACCESS_COOKIE,
              'Idempotency-Key': '00000000-0000-7000-8000-e00000000052',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(SEND_BODY),
          },
        );
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('ENGAGEMENT_STATE_INVALID');
      });
  });

  it('send returns the cached response on Idempotency-Key replay', async () => {
    await provider
      .addInteraction()
      .given('a prior outreach-send response is cached under an Idempotency-Key')
      .uponReceiving('an outreach send replay with the same Idempotency-Key and body')
      .withRequest('POST', `/v1/engagements/${ENGAGED_SEND_ID}/outreach/send`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid(K_SEND_REPLAY),
          'Content-Type': 'application/json',
        }).jsonBody(SEND_BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(sendResponse());
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/engagements/${ENGAGED_SEND_ID}/outreach/send`,
          {
            method: 'POST',
            headers: {
              Cookie: ACCESS_COOKIE,
              'Idempotency-Key': K_SEND_REPLAY,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(SEND_BODY),
          },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { engagement: { state: string } };
        expect(body.engagement.state).toBe('awaiting_response');
      });
  });

  it('send returns 409 IDEMPOTENCY_KEY_CONFLICT on a key reused with a different body', async () => {
    await provider
      .addInteraction()
      .given('an Idempotency-Key was used with a different outreach-send body')
      .uponReceiving('an outreach send with a conflicting Idempotency-Key')
      .withRequest('POST', `/v1/engagements/${ENGAGED_SEND_ID}/outreach/send`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid(K_SEND_CONFLICT),
          'Content-Type': 'application/json',
        }).jsonBody(SEND_BODY);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(idempotencyConflictError());
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/engagements/${ENGAGED_SEND_ID}/outreach/send`,
          {
            method: 'POST',
            headers: {
              Cookie: ACCESS_COOKIE,
              'Idempotency-Key': K_SEND_CONFLICT,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(SEND_BODY),
          },
        );
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      });
  });

  it('returns 403 CONSENT_NOT_GRANTED_AT_SEND when no contacting consent grant exists', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an engagement in engaged state with a prior outreach_drafted event but contacting consent not granted exist')
      .uponReceiving('an outreach send blocked by the binding consent gate')
      .withRequest('POST', `/v1/engagements/${ENGAGED_SEND_NO_CONSENT_ID}/outreach/send`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid('00000000-0000-7000-8000-e00000000053'),
          'Content-Type': 'application/json',
        }).jsonBody(SEND_BODY);
      })
      .willRespondWith(403, (b) => {
        b.jsonBody(consentNotGrantedError());
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/engagements/${ENGAGED_SEND_NO_CONSENT_ID}/outreach/send`,
          {
            method: 'POST',
            headers: {
              Cookie: ACCESS_COOKIE,
              'Idempotency-Key': '00000000-0000-7000-8000-e00000000053',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(SEND_BODY),
          },
        );
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('CONSENT_NOT_GRANTED_AT_SEND');
      });
  });

  it('returns 422 ENGAGEMENT_REFERENCE_NOT_FOUND when draft_event_id does not resolve', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an engagement in engaged state exist')
      .uponReceiving('an outreach send referencing an unknown draft_event_id')
      .withRequest('POST', `/v1/engagements/${ENGAGED_ID}/outreach/send`, (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Idempotency-Key': uuid('00000000-0000-7000-8000-e00000000054'),
          'Content-Type': 'application/json',
        }).jsonBody({
          draft_event_id: NONEXISTENT_DRAFT_REF,
          final_text: 'Hello — we have a role that matches your background.',
        });
      })
      .willRespondWith(422, (b) => {
        b.jsonBody(referenceNotFoundError());
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/engagements/${ENGAGED_ID}/outreach/send`,
          {
            method: 'POST',
            headers: {
              Cookie: ACCESS_COOKIE,
              'Idempotency-Key': '00000000-0000-7000-8000-e00000000054',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              draft_event_id: NONEXISTENT_DRAFT_REF,
              final_text: 'Hello — we have a role that matches your background.',
            }),
          },
        );
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('ENGAGEMENT_REFERENCE_NOT_FOUND');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
