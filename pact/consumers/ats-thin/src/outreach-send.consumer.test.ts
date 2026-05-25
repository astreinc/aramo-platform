import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, regex } = MatchersV3;

// M5 PR-6 §4.13 — Pact consumer for POST /v1/engagements/{id}/outreach.
// 4 interactions: happy (engaged) + ENGAGEMENT_STATE_INVALID (surfaced)
// + NOT_FOUND + portal refusal.
//
// Notes:
//   - The provider verifier overrides DraftProvider + DeliveryProvider
//     with canned mocks so the verification doesn't need real Anthropic
//     / SES wiring (per directive §4.14 + Ruling 13).
//   - The `outreach_sent` literal here is part of the canonical
//     engagement-event vocabulary (TIER2_EXCLUDES exempted).

const provider = new PactV4({
  consumer: 'ats-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const REQ_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const ENGAGEMENT_ENGAGED = '00000000-0000-7000-8000-ffff00000f01';
const ENGAGEMENT_SURFACED = '00000000-0000-7000-8000-ffff00000f02';
const ENGAGEMENT_MISSING = '00000000-0000-7000-8000-ffff00000f99';
const AUDIT_RECORD_ID = '00000000-0000-7000-8000-ffff0a000001';
const DELIVERY_ID = '00000000-0000-7000-8000-ffff0d000001';
const OUTREACH_EVENT_ID = '00000000-0000-7000-8000-ffff0e000001';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-ffff00000f02';
const IDEMPOTENCY_KEY_1 = '0190d5a4-7e01-7e2a-a4d3-ffff00000f11';
const IDEMPOTENCY_KEY_2 = '0190d5a4-7e01-7e2a-a4d3-ffff00000f12';
const IDEMPOTENCY_KEY_3 = '0190d5a4-7e01-7e2a-a4d3-ffff00000f13';
const IDEMPOTENCY_KEY_4 = '0190d5a4-7e01-7e2a-a4d3-ffff00000f14';

describe('ATS thin consumer → POST /v1/engagements/{id}/outreach', () => {
  it('returns 200 with engagement transitioned to awaiting_response when engagement is in engaged state', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated and an engagement exists in engaged state for tenant')
      .uponReceiving('an outreach-send request for an engagement in engaged state')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_ENGAGED}/outreach`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY_1),
          'Content-Type': 'application/json',
        }).jsonBody({
          prompt: like('Reach out to talent about the role.'),
          max_tokens: like(512),
        });
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          engagement: {
            id: uuid(ENGAGEMENT_ENGAGED),
            tenant_id: uuid(TENANT_ID),
            talent_id: uuid(TALENT_ID),
            requisition_id: uuid(REQ_ID),
            examination_id: null,
            state: regex(
              'surfaced|evaluated|engaged|maybe|passed|awaiting_response|responded|in_conversation|not_interested|ready_for_submittal|submitted',
              'awaiting_response',
            ),
            created_at: like('2026-05-25T10:00:00.000Z'),
          },
          outreach_event: {
            id: uuid(OUTREACH_EVENT_ID),
            tenant_id: uuid(TENANT_ID),
            engagement_id: uuid(ENGAGEMENT_ENGAGED),
            event_type: regex(
              'state_transition|outreach_sent|response_received|conversation_started',
              'outreach_sent',
            ),
            event_payload: like({
              ai_draft_audit_record_id: AUDIT_RECORD_ID,
              model_used: 'claude-sonnet-mock',
              input_tokens: 10,
              output_tokens: 20,
              duration_ms: 100,
              delivered_at: '2026-05-25T10:01:00.000Z',
              delivery_channel: 'email',
              delivery_id: DELIVERY_ID,
            }),
            created_at: like('2026-05-25T10:01:00.000Z'),
          },
          delivery_id: like(DELIVERY_ID),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_ENGAGED}/outreach`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': IDEMPOTENCY_KEY_1,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt: 'Reach out to talent about the role.',
            max_tokens: 512,
          }),
        });
        expect(res.status).toBe(200);
      });
  });

  it('returns 422 ENGAGEMENT_STATE_INVALID when engagement not in engaged state', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated and an engagement exists in non-engaged state for outreach')
      .uponReceiving('an outreach-send request for an engagement in non-engaged state')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_SURFACED}/outreach`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY_2),
          'Content-Type': 'application/json',
        }).jsonBody({ prompt: like('Reach out to talent about the role.') });
      })
      .willRespondWith(422, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          error: {
            code: like('ENGAGEMENT_STATE_INVALID'),
            message: like('Illegal engagement state transition: surfaced -> awaiting_response'),
            request_id: uuid(REQUEST_ID),
            details: like({ from_state: 'surfaced', to_state: 'awaiting_response' }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_SURFACED}/outreach`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': IDEMPOTENCY_KEY_2,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ prompt: 'Reach out to talent about the role.' }),
        });
        expect(res.status).toBe(422);
      });
  });

  it('returns 404 NOT_FOUND when engagement does not exist for tenant', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated but no engagement exists for tenant for outreach')
      .uponReceiving('an outreach-send request for a non-existent engagement')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_MISSING}/outreach`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY_3),
          'Content-Type': 'application/json',
        }).jsonBody({ prompt: like('Reach out to talent about the role.') });
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
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_MISSING}/outreach`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': IDEMPOTENCY_KEY_3,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ prompt: 'Reach out to talent about the role.' }),
        });
        expect(res.status).toBe(404);
      });
  });

  it('returns 403 INSUFFICIENT_PERMISSIONS with a portal JWT', async () => {
    await provider
      .addInteraction()
      .given('a portal user has authenticated against the outreach-send endpoint')
      .uponReceiving('an outreach-send request with a portal JWT')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_ENGAGED}/outreach`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.portal.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY_4),
          'Content-Type': 'application/json',
        }).jsonBody({ prompt: like('Reach out to talent about the role.') });
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
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_ENGAGED}/outreach`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.portal.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': IDEMPOTENCY_KEY_4,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ prompt: 'Reach out to talent about the role.' }),
        });
        expect(res.status).toBe(403);
      });
  });
});
