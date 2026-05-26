import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, regex } = MatchersV3;

// M5 PR-8a §4.9 — Pact consumer for POST /v1/engagements/{id}/conversation.
// 3 interactions: happy (200) + ENGAGEMENT_STATE_INVALID (422; covers
// both illegal-state and natural-key dedup via engagement already in
// in_conversation) + INSUFFICIENT_PERMISSIONS (403).
//
// SMALLER than PR-7's 4-interaction footprint because PR-8a has no
// cross-event reference (Ruling 3) — the ENGAGEMENT_REFERENCE_NOT_FOUND
// refusal path doesn't exist on this surface.

const provider = new PactV4({
  consumer: 'ats-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const REQ_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
// Reuse PR-7's seeded `responded`-state engagement to avoid duplicating
// the provider-side state handler (the existing
// "engagement exists in responded state for tenant" handler at
// pact/provider/src/verify-api.ts seeds this exact id at state='responded').
const ENGAGEMENT_RESPONDED = '00000000-0000-7000-8000-eeee00000e02';
const ENGAGEMENT_IN_CONVERSATION = '00000000-0000-7000-8000-cccc00000c02';
const CONVERSATION_EVENT_ID = '00000000-0000-7000-8000-cccc0e000001';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-cccc00000c02';
const IDEMPOTENCY_KEY_1 = '0190d5a4-7e01-7e2a-a4d3-cccc00000c11';
const IDEMPOTENCY_KEY_2 = '0190d5a4-7e01-7e2a-a4d3-cccc00000c12';
const IDEMPOTENCY_KEY_3 = '0190d5a4-7e01-7e2a-a4d3-cccc00000c13';
const CONVERSATION_STARTED_AT = '2026-05-25T12:00:00.000Z';

describe('ATS thin consumer → POST /v1/engagements/{id}/conversation', () => {
  it('returns 200 with engagement transitioned to in_conversation when engagement is in responded state', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated and an engagement exists in responded state for tenant')
      .uponReceiving('a conversation-started request for an engagement in responded state')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_RESPONDED}/conversation`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY_1),
          'Content-Type': 'application/json',
        }).jsonBody({
          conversation_started_at: like(CONVERSATION_STARTED_AT),
        });
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          engagement: {
            id: uuid(ENGAGEMENT_RESPONDED),
            tenant_id: uuid(TENANT_ID),
            talent_id: uuid(TALENT_ID),
            requisition_id: uuid(REQ_ID),
            examination_id: null,
            state: regex(
              'surfaced|evaluated|engaged|maybe|passed|awaiting_response|responded|in_conversation|not_interested|ready_for_submittal|submitted',
              'in_conversation',
            ),
            created_at: like('2026-05-25T10:00:00.000Z'),
          },
          conversation_event: {
            id: uuid(CONVERSATION_EVENT_ID),
            tenant_id: uuid(TENANT_ID),
            engagement_id: uuid(ENGAGEMENT_RESPONDED),
            event_type: regex(
              'state_transition|outreach_sent|response_received|conversation_started',
              'conversation_started',
            ),
            event_payload: like({
              conversation_started_at: CONVERSATION_STARTED_AT,
              recorded_by_user_id: '00000000-0000-7000-8000-000000000bb1',
            }),
            created_at: like('2026-05-25T12:00:01.000Z'),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_RESPONDED}/conversation`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': IDEMPOTENCY_KEY_1,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            conversation_started_at: CONVERSATION_STARTED_AT,
          }),
        });
        expect(res.status).toBe(200);
      });
  });

  it('returns 422 ENGAGEMENT_STATE_INVALID when engagement not in responded state (covers natural-key dedup via engagement already in in_conversation)', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated and an engagement exists in in_conversation state for tenant')
      .uponReceiving('a conversation-started request for an engagement already in in_conversation state')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_IN_CONVERSATION}/conversation`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY_2),
          'Content-Type': 'application/json',
        }).jsonBody({
          conversation_started_at: like(CONVERSATION_STARTED_AT),
        });
      })
      .willRespondWith(422, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          error: {
            code: like('ENGAGEMENT_STATE_INVALID'),
            message: like('Illegal engagement state transition: in_conversation -> in_conversation'),
            request_id: uuid(REQUEST_ID),
            details: like({ from_state: 'in_conversation', to_state: 'in_conversation' }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_IN_CONVERSATION}/conversation`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': IDEMPOTENCY_KEY_2,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            conversation_started_at: CONVERSATION_STARTED_AT,
          }),
        });
        expect(res.status).toBe(422);
      });
  });

  it('returns 403 INSUFFICIENT_PERMISSIONS with a portal JWT', async () => {
    await provider
      .addInteraction()
      .given('a portal user has authenticated against the conversation-started endpoint')
      .uponReceiving('a conversation-started request with a portal JWT')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_RESPONDED}/conversation`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.portal.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY_3),
          'Content-Type': 'application/json',
        }).jsonBody({
          conversation_started_at: like(CONVERSATION_STARTED_AT),
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
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_RESPONDED}/conversation`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.portal.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': IDEMPOTENCY_KEY_3,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            conversation_started_at: CONVERSATION_STARTED_AT,
          }),
        });
        expect(res.status).toBe(403);
      });
  });
});
