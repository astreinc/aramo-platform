import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, regex } = MatchersV3;

// M5 PR-7 §4.9 — Pact consumer for POST /v1/engagements/{id}/response.
// 4 interactions: happy (200) + ENGAGEMENT_STATE_INVALID (422) +
// ENGAGEMENT_REFERENCE_NOT_FOUND (422) + INSUFFICIENT_PERMISSIONS (403).

const provider = new PactV4({
  consumer: 'ats-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const REQ_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const ENGAGEMENT_AWAITING = '00000000-0000-7000-8000-eeee00000e01';
const ENGAGEMENT_RESPONDED = '00000000-0000-7000-8000-eeee00000e02';
const ENGAGEMENT_AWAITING_NOREF = '00000000-0000-7000-8000-eeee00000e03';
const OUTREACH_EVENT_ID = '00000000-0000-7000-8000-eeee0e000001';
const RESPONSE_EVENT_ID = '00000000-0000-7000-8000-eeee0e000002';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-eeee00000e02';
const IDEMPOTENCY_KEY_1 = '0190d5a4-7e01-7e2a-a4d3-eeee00000e11';
const IDEMPOTENCY_KEY_2 = '0190d5a4-7e01-7e2a-a4d3-eeee00000e12';
const IDEMPOTENCY_KEY_3 = '0190d5a4-7e01-7e2a-a4d3-eeee00000e13';
const IDEMPOTENCY_KEY_4 = '0190d5a4-7e01-7e2a-a4d3-eeee00000e14';
const RESPONSE_RECEIVED_AT = '2026-05-25T11:00:00.000Z';

describe('ATS thin consumer → POST /v1/engagements/{id}/response', () => {
  it('returns 200 with engagement transitioned to responded when engagement is in awaiting_response state', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated and an engagement exists in awaiting_response state with a prior outreach_sent event for tenant')
      .uponReceiving('a response-received request for an engagement in awaiting_response state')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_AWAITING}/response`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY_1),
          'Content-Type': 'application/json',
        }).jsonBody({
          response_received_at: like(RESPONSE_RECEIVED_AT),
          outreach_event_ref_id: uuid(OUTREACH_EVENT_ID),
        });
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          engagement: {
            id: uuid(ENGAGEMENT_AWAITING),
            tenant_id: uuid(TENANT_ID),
            talent_id: uuid(TALENT_ID),
            requisition_id: uuid(REQ_ID),
            examination_id: null,
            state: regex(
              'surfaced|evaluated|engaged|maybe|passed|awaiting_response|responded|in_conversation|not_interested|ready_for_submittal|submitted',
              'responded',
            ),
            created_at: like('2026-05-25T10:00:00.000Z'),
          },
          response_event: {
            id: uuid(RESPONSE_EVENT_ID),
            tenant_id: uuid(TENANT_ID),
            engagement_id: uuid(ENGAGEMENT_AWAITING),
            event_type: regex(
              'state_transition|outreach_sent|response_received|conversation_started',
              'response_received',
            ),
            event_payload: like({
              response_received_at: RESPONSE_RECEIVED_AT,
              recorded_by_user_id: '00000000-0000-7000-8000-000000000bb1',
              outreach_event_ref_id: OUTREACH_EVENT_ID,
            }),
            created_at: like('2026-05-25T11:00:01.000Z'),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_AWAITING}/response`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': IDEMPOTENCY_KEY_1,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            response_received_at: RESPONSE_RECEIVED_AT,
            outreach_event_ref_id: OUTREACH_EVENT_ID,
          }),
        });
        expect(res.status).toBe(200);
      });
  });

  it('returns 422 ENGAGEMENT_STATE_INVALID when engagement not in awaiting_response state', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated and an engagement exists in responded state for tenant')
      .uponReceiving('a response-received request for an engagement already in responded state')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_RESPONDED}/response`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY_2),
          'Content-Type': 'application/json',
        }).jsonBody({
          response_received_at: like(RESPONSE_RECEIVED_AT),
          outreach_event_ref_id: uuid(OUTREACH_EVENT_ID),
        });
      })
      .willRespondWith(422, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          error: {
            code: like('ENGAGEMENT_STATE_INVALID'),
            message: like('Illegal engagement state transition: responded -> responded'),
            request_id: uuid(REQUEST_ID),
            details: like({ from_state: 'responded', to_state: 'responded' }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_RESPONDED}/response`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': IDEMPOTENCY_KEY_2,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            response_received_at: RESPONSE_RECEIVED_AT,
            outreach_event_ref_id: OUTREACH_EVENT_ID,
          }),
        });
        expect(res.status).toBe(422);
      });
  });

  it('returns 422 ENGAGEMENT_REFERENCE_NOT_FOUND when outreach_event_ref_id does not resolve to a prior outreach_sent event', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated and an engagement exists in awaiting_response state but no outreach_sent event matches the outreach_event_ref_id')
      .uponReceiving('a response-received request whose outreach_event_ref_id does not resolve')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_AWAITING_NOREF}/response`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY_3),
          'Content-Type': 'application/json',
        }).jsonBody({
          response_received_at: like(RESPONSE_RECEIVED_AT),
          outreach_event_ref_id: uuid(OUTREACH_EVENT_ID),
        });
      })
      .willRespondWith(422, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          error: {
            code: like('ENGAGEMENT_REFERENCE_NOT_FOUND'),
            message: like('outreach_event_ref_id not found, not in tenant, or not an outreach_sent event'),
            request_id: uuid(REQUEST_ID),
            details: like({ field: 'outreach_event_ref_id' }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_AWAITING_NOREF}/response`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': IDEMPOTENCY_KEY_3,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            response_received_at: RESPONSE_RECEIVED_AT,
            outreach_event_ref_id: OUTREACH_EVENT_ID,
          }),
        });
        expect(res.status).toBe(422);
      });
  });

  it('returns 403 INSUFFICIENT_PERMISSIONS with a portal JWT', async () => {
    await provider
      .addInteraction()
      .given('a portal user has authenticated against the response-received endpoint')
      .uponReceiving('a response-received request with a portal JWT')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_AWAITING}/response`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.portal.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY_4),
          'Content-Type': 'application/json',
        }).jsonBody({
          response_received_at: like(RESPONSE_RECEIVED_AT),
          outreach_event_ref_id: uuid(OUTREACH_EVENT_ID),
        });
      })
      .willRespondWith(403, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          error: {
            code: like('INSUFFICIENT_PERMISSIONS'),
            message: like('engagement endpoints are recruiter-only'),
            request_id: uuid(REQUEST_ID),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_AWAITING}/response`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.portal.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': IDEMPOTENCY_KEY_4,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            response_received_at: RESPONSE_RECEIVED_AT,
            outreach_event_ref_id: OUTREACH_EVENT_ID,
          }),
        });
        expect(res.status).toBe(403);
      });
  });

  // M5 PR-9 §4.1 — idempotency replay + conflict per Plan v1.5 §M5 Track B item 2.
  // PL-71: body shape MUST match RecordResponseRequestDto (two fields, no
  // response_event_id — that field is NOT part of the request DTO).
  // forbidNonWhitelisted would otherwise reject extra fields before the
  // idempotency check fires.
  const REPLAY_KEY = '0190d5a4-7e01-7e2a-a4d3-eeee00000e20';
  const CONFLICT_KEY = '0190d5a4-7e01-7e2a-a4d3-eeee00000e21';
  const RESPONSE_BODY = {
    response_received_at: RESPONSE_RECEIVED_AT,
    outreach_event_ref_id: OUTREACH_EVENT_ID,
  };

  it('idempotency replay: same key + same body returns cached 200 response', async () => {
    await provider
      .addInteraction()
      .given('an idempotency key has been recorded with a prior response-received response')
      .uponReceiving('a response-received request replaying a prior key + body')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_AWAITING}/response`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(REPLAY_KEY),
          'Content-Type': 'application/json',
        }).jsonBody(RESPONSE_BODY);
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          engagement: like({ id: ENGAGEMENT_AWAITING, state: 'responded' }),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_AWAITING}/response`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': REPLAY_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(RESPONSE_BODY),
        });
        expect(res.status).toBe(200);
      });
  });

  it('idempotency conflict: same key + different body returns 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
    await provider
      .addInteraction()
      .given('an idempotency key has been recorded with a different response-received body')
      .uponReceiving('a response-received request with a conflicting prior key')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_AWAITING}/response`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(CONFLICT_KEY),
          'Content-Type': 'application/json',
        }).jsonBody(RESPONSE_BODY);
      })
      .willRespondWith(409, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          error: {
            code: regex('IDEMPOTENCY_KEY_CONFLICT', 'IDEMPOTENCY_KEY_CONFLICT'),
            message: like('Same idempotency key used with a different request body'),
            request_id: uuid(REQUEST_ID),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_AWAITING}/response`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': CONFLICT_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(RESPONSE_BODY),
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      });
  });
});
