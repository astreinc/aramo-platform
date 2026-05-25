import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, regex, eachLike } = MatchersV3;

// M5 PR-4 §4.8 — Pact consumer for GET /v1/engagements/{id} +
// GET /v1/engagements/{id}/events. 6 interactions total.

const provider = new PactV4({
  consumer: 'ats-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const REQ_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const ENGAGEMENT_EXISTS = '00000000-0000-7000-8000-eeee00000e01';
const ENGAGEMENT_MISSING = '00000000-0000-7000-8000-eeee00000e99';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-eeee00000e02';

describe('ATS thin consumer → GET /v1/engagements/{id}', () => {
  it('returns 200 with engagement view', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated and an engagement exists for tenant')
      .uponReceiving('an engagement read request for an existing engagement')
      .withRequest('GET', `/v1/engagements/${ENGAGEMENT_EXISTS}`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
        });
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          id: uuid(ENGAGEMENT_EXISTS),
          tenant_id: uuid(TENANT_ID),
          talent_id: uuid(TALENT_ID),
          requisition_id: uuid(REQ_ID),
          examination_id: null,
          state: regex(
            'surfaced|evaluated|engaged|maybe|passed|awaiting_response|responded|in_conversation|not_interested|ready_for_submittal|submitted',
            'surfaced',
          ),
          created_at: like('2026-05-25T10:00:00.000Z'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_EXISTS}`, {
          headers: { Authorization: 'Bearer eyJfake.token', 'X-Request-ID': REQUEST_ID },
        });
        expect(res.status).toBe(200);
      });
  });

  it('returns 404 NOT_FOUND when engagement does not exist for tenant', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated but the engagement does not exist for tenant')
      .uponReceiving('an engagement read request for a non-existent engagement')
      .withRequest('GET', `/v1/engagements/${ENGAGEMENT_MISSING}`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
        });
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
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_MISSING}`, {
          headers: { Authorization: 'Bearer eyJfake.token', 'X-Request-ID': REQUEST_ID },
        });
        expect(res.status).toBe(404);
      });
  });

  it('returns 403 INSUFFICIENT_PERMISSIONS with a portal JWT (engagement read)', async () => {
    await provider
      .addInteraction()
      .given('a portal user has authenticated against the engagement-read endpoint')
      .uponReceiving('an engagement read request with a portal JWT')
      .withRequest('GET', `/v1/engagements/${ENGAGEMENT_EXISTS}`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.portal.token'),
          'X-Request-ID': uuid(REQUEST_ID),
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
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_EXISTS}`, {
          headers: { Authorization: 'Bearer eyJfake.portal.token', 'X-Request-ID': REQUEST_ID },
        });
        expect(res.status).toBe(403);
      });
  });
});

describe('ATS thin consumer → GET /v1/engagements/{id}/events', () => {
  it('returns 200 with events array', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated and an engagement with at least one event exists for tenant')
      .uponReceiving('an engagement events read request for an existing engagement')
      .withRequest('GET', `/v1/engagements/${ENGAGEMENT_EXISTS}/events`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
        });
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          events: eachLike(
            {
              id: uuid(),
              tenant_id: uuid(TENANT_ID),
              engagement_id: uuid(ENGAGEMENT_EXISTS),
              event_type: regex(
                'state_transition|outreach_sent|response_received|conversation_started',
                'state_transition',
              ),
              event_payload: like({ from_state: null, to_state: 'surfaced' }),
              created_at: like('2026-05-25T10:00:00.000Z'),
            },
            1,
          ),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_EXISTS}/events`, {
          headers: { Authorization: 'Bearer eyJfake.token', 'X-Request-ID': REQUEST_ID },
        });
        expect(res.status).toBe(200);
      });
  });

  it('returns 404 NOT_FOUND when engagement does not exist (events endpoint)', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated but the engagement does not exist for tenant')
      .uponReceiving('an engagement events read request for a non-existent engagement')
      .withRequest('GET', `/v1/engagements/${ENGAGEMENT_MISSING}/events`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
        });
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
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_MISSING}/events`, {
          headers: { Authorization: 'Bearer eyJfake.token', 'X-Request-ID': REQUEST_ID },
        });
        expect(res.status).toBe(404);
      });
  });

  it('returns 403 INSUFFICIENT_PERMISSIONS with a portal JWT (events endpoint)', async () => {
    await provider
      .addInteraction()
      .given('a portal user has authenticated against the engagement-events endpoint')
      .uponReceiving('an engagement events read request with a portal JWT')
      .withRequest('GET', `/v1/engagements/${ENGAGEMENT_EXISTS}/events`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.portal.token'),
          'X-Request-ID': uuid(REQUEST_ID),
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
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_EXISTS}/events`, {
          headers: { Authorization: 'Bearer eyJfake.portal.token', 'X-Request-ID': REQUEST_ID },
        });
        expect(res.status).toBe(403);
      });
  });
});
