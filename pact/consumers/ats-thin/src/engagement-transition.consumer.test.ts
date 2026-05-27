import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, regex } = MatchersV3;

// M5 PR-4 §4.8 — Pact consumer for POST /v1/engagements/{id}/transitions.
// 4 interactions: happy + ENGAGEMENT_STATE_INVALID + NOT_FOUND + portal refusal.

const provider = new PactV4({
  consumer: 'ats-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const REQ_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const ENGAGEMENT_SURFACED = '00000000-0000-7000-8000-dddd00000d01';
const ENGAGEMENT_MISSING = '00000000-0000-7000-8000-dddd00000d99';
const EVENT_ID = '00000000-0000-7000-8000-dddd0e0000e1';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-dddd00000d02';
const IDEMPOTENCY_KEY_1 = '0190d5a4-7e01-7e2a-a4d3-dddd00000d11';
const IDEMPOTENCY_KEY_2 = '0190d5a4-7e01-7e2a-a4d3-dddd00000d12';
const IDEMPOTENCY_KEY_3 = '0190d5a4-7e01-7e2a-a4d3-dddd00000d13';
const IDEMPOTENCY_KEY_4 = '0190d5a4-7e01-7e2a-a4d3-dddd00000d14';

describe('ATS thin consumer → POST /v1/engagements/{id}/transitions', () => {
  it('returns 200 with updated engagement when state transition succeeds (surfaced → evaluated)', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated and an engagement exists in surfaced state for tenant')
      .uponReceiving('an engagement-transition request from surfaced to evaluated')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_SURFACED}/transitions`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY_1),
          'Content-Type': 'application/json',
        }).jsonBody({ to_state: 'evaluated', event_id: uuid(EVENT_ID) });
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          engagement: {
            id: uuid(ENGAGEMENT_SURFACED),
            tenant_id: uuid(TENANT_ID),
            talent_id: uuid(TALENT_ID),
            requisition_id: uuid(REQ_ID),
            examination_id: null,
            state: regex(
              'surfaced|evaluated|engaged|maybe|passed|awaiting_response|responded|in_conversation|not_interested|ready_for_submittal|submitted',
              'evaluated',
            ),
            created_at: like('2026-05-25T10:00:00.000Z'),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_SURFACED}/transitions`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': IDEMPOTENCY_KEY_1,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ to_state: 'evaluated', event_id: EVENT_ID }),
        });
        expect(res.status).toBe(200);
      });
  });

  it('returns 422 ENGAGEMENT_STATE_INVALID for illegal transition (surfaced → submitted)', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated and an engagement exists in surfaced state for tenant')
      .uponReceiving('an engagement-transition request for an illegal skip from surfaced to submitted')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_SURFACED}/transitions`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY_2),
          'Content-Type': 'application/json',
        }).jsonBody({ to_state: 'submitted', event_id: uuid(EVENT_ID) });
      })
      .willRespondWith(422, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          error: {
            code: like('ENGAGEMENT_STATE_INVALID'),
            message: like('Illegal engagement state transition: surfaced -> submitted'),
            request_id: uuid(REQUEST_ID),
            details: like({ from_state: 'surfaced', to_state: 'submitted' }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_SURFACED}/transitions`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': IDEMPOTENCY_KEY_2,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ to_state: 'submitted', event_id: EVENT_ID }),
        });
        expect(res.status).toBe(422);
      });
  });

  it('returns 404 NOT_FOUND when engagement does not exist for tenant', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated but the engagement does not exist for tenant')
      .uponReceiving('an engagement-transition request for a non-existent engagement')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_MISSING}/transitions`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY_3),
          'Content-Type': 'application/json',
        }).jsonBody({ to_state: 'evaluated', event_id: uuid(EVENT_ID) });
      })
      .willRespondWith(404, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          error: {
            code: like('NOT_FOUND'),
            message: like('TalentJobEngagement not found'),
            request_id: uuid(REQUEST_ID),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_MISSING}/transitions`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': IDEMPOTENCY_KEY_3,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ to_state: 'evaluated', event_id: EVENT_ID }),
        });
        expect(res.status).toBe(404);
      });
  });

  it('returns 403 INSUFFICIENT_PERMISSIONS with a portal JWT', async () => {
    await provider
      .addInteraction()
      .given('a portal user has authenticated against the engagement-transition endpoint')
      .uponReceiving('an engagement-transition request with a portal JWT')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_SURFACED}/transitions`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.portal.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY_4),
          'Content-Type': 'application/json',
        }).jsonBody({ to_state: 'evaluated', event_id: uuid(EVENT_ID) });
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
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_SURFACED}/transitions`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.portal.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': IDEMPOTENCY_KEY_4,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ to_state: 'evaluated', event_id: EVENT_ID }),
        });
        expect(res.status).toBe(403);
      });
  });

  // M5 PR-9 §4.1 — idempotency replay + conflict per Plan v1.5 §M5 Track B item 2.
  const REPLAY_KEY = '0190d5a4-7e01-7e2a-a4d3-dddd00000d20';
  const CONFLICT_KEY = '0190d5a4-7e01-7e2a-a4d3-dddd00000d21';
  const TRANSITION_BODY = { to_state: 'evaluated', event_id: EVENT_ID };

  it('idempotency replay: same key + same body returns cached 200 response', async () => {
    await provider
      .addInteraction()
      .given('an idempotency key has been recorded with a prior engagement-transition response')
      .uponReceiving('an engagement-transition request replaying a prior key + body')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_SURFACED}/transitions`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(REPLAY_KEY),
          'Content-Type': 'application/json',
        }).jsonBody(TRANSITION_BODY);
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          engagement: like({ id: ENGAGEMENT_SURFACED, state: 'evaluated' }),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_SURFACED}/transitions`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': REPLAY_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(TRANSITION_BODY),
        });
        expect(res.status).toBe(200);
      });
  });

  it('idempotency conflict: same key + different body returns 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
    await provider
      .addInteraction()
      .given('an idempotency key has been recorded with a different engagement-transition body')
      .uponReceiving('an engagement-transition request with a conflicting prior key')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_SURFACED}/transitions`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(CONFLICT_KEY),
          'Content-Type': 'application/json',
        }).jsonBody(TRANSITION_BODY);
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
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_SURFACED}/transitions`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': CONFLICT_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(TRANSITION_BODY),
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      });
  });

  // Suppress unused-IDEMPOTENCY_KEY_4 warning.
  void TALENT_ID;
  void REQ_ID;
  void ENGAGEMENT_MISSING;
  void IDEMPOTENCY_KEY_4;
});
