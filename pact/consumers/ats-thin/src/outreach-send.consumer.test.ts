import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, regex } = MatchersV3;

// Outreach Draft/Preview Directive v1.0 / Amendment v1.1 — Pact consumer for
// the SPLIT outreach endpoints. The atomic POST /v1/engagements/{id}/outreach
// was removed; this contract covers POST .../outreach/draft (generation,
// no delivery) + POST .../outreach/send (delivery, consent-at-send).
//
// Notes:
//   - The provider verifier overrides DraftProvider + DeliveryProvider with
//     canned mocks so verification needs no real Anthropic / SES wiring.
//   - The send interactions reference a provider-seeded outreach_drafted
//     event by a fixed id (the cross-event-ref the send validates).
//   - `outreach_sent` / `outreach_drafted` are canonical engagement-event
//     vocabulary (TIER2_EXCLUDES exempted).

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
const ENGAGEMENT_CONSENT_REVOKED = '00000000-0000-7000-8000-ffff00000f31';
const DRAFT_EVENT_ID = '00000000-0000-7000-8000-ffff0dddd001';
const DRAFT_EVENT_ID_REVOKED = '00000000-0000-7000-8000-ffff0dddd031';
const DRAFT_EVENT_ID_UNKNOWN = '00000000-0000-7000-8000-ffff0dddd999';
const AUDIT_RECORD_ID = '00000000-0000-7000-8000-ffff0a000001';
const DELIVERY_ID = '00000000-0000-7000-8000-ffff0d000001';
const OUTREACH_EVENT_ID = '00000000-0000-7000-8000-ffff0e000001';
const DECISION_ID = '00000000-0000-7000-8000-ffff0d000031';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-ffff00000f02';
const K1 = '0190d5a4-7e01-7e2a-a4d3-ffff00000f11';
const K2 = '0190d5a4-7e01-7e2a-a4d3-ffff00000f12';
const K3 = '0190d5a4-7e01-7e2a-a4d3-ffff00000f13';
const K4 = '0190d5a4-7e01-7e2a-a4d3-ffff00000f14';
const K5 = '0190d5a4-7e01-7e2a-a4d3-ffff00000f15';
const K6 = '0190d5a4-7e01-7e2a-a4d3-ffff00000f16';
const K7 = '0190d5a4-7e01-7e2a-a4d3-ffff00000f17';
const K8 = '0190d5a4-7e01-7e2a-a4d3-ffff00000f18';

const DRAFT_BODY = { prompt: 'Reach out to talent about the role.', max_tokens: 512 };

// ====================== DRAFT — POST .../outreach/draft ====================
describe('ATS thin consumer → POST /v1/engagements/{id}/outreach/draft', () => {
  it('200: generates + persists a PENDING draft for an engaged engagement (no delivery)', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated and an engagement exists in engaged state for tenant')
      .uponReceiving('an outreach-draft request for an engagement in engaged state')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_ENGAGED}/outreach/draft`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(K1),
          'Content-Type': 'application/json',
        }).jsonBody(DRAFT_BODY);
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          draft_event_id: uuid('00000000-0000-7000-8000-ffff0dddd0aa'),
          draft_text: like('Mocked AI draft for pact verification.'),
          ai_draft_audit_record_id: uuid(AUDIT_RECORD_ID),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_ENGAGED}/outreach/draft`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': K1,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(DRAFT_BODY),
        });
        expect(res.status).toBe(200);
      });
  });

  it('422 ENGAGEMENT_STATE_INVALID when engagement not in engaged state (gated to engaged)', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated and an engagement exists in non-engaged state for outreach')
      .uponReceiving('an outreach-draft request for an engagement in non-engaged state')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_SURFACED}/outreach/draft`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(K2),
          'Content-Type': 'application/json',
        }).jsonBody(DRAFT_BODY);
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
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_SURFACED}/outreach/draft`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': K2,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(DRAFT_BODY),
        });
        expect(res.status).toBe(422);
      });
  });

  it('404 NOT_FOUND when engagement does not exist for tenant', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated but no engagement exists for tenant for outreach')
      .uponReceiving('an outreach-draft request for a non-existent engagement')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_MISSING}/outreach/draft`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(K3),
          'Content-Type': 'application/json',
        }).jsonBody(DRAFT_BODY);
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
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_MISSING}/outreach/draft`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': K3,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(DRAFT_BODY),
        });
        expect(res.status).toBe(404);
      });
  });

  it('403 INSUFFICIENT_PERMISSIONS with a portal JWT', async () => {
    await provider
      .addInteraction()
      .given('a portal user has authenticated against the outreach-send endpoint')
      .uponReceiving('an outreach-draft request with a portal JWT')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_ENGAGED}/outreach/draft`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.portal.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(K4),
          'Content-Type': 'application/json',
        }).jsonBody(DRAFT_BODY);
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
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_ENGAGED}/outreach/draft`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.portal.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': K4,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(DRAFT_BODY),
        });
        expect(res.status).toBe(403);
      });
  });
});

// ====================== SEND — POST .../outreach/send ======================
describe('ATS thin consumer → POST /v1/engagements/{id}/outreach/send', () => {
  const sendBody = { draft_event_id: DRAFT_EVENT_ID, final_text: 'Reach out to talent about the role.' };

  it('200: delivers the approved draft and transitions to awaiting_response', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated and an engagement in engaged state with a prior outreach_drafted event exists for tenant')
      .uponReceiving('an outreach-send request referencing a prior draft')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_ENGAGED}/outreach/send`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(K5),
          'Content-Type': 'application/json',
        }).jsonBody(sendBody);
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
              'state_transition|outreach_drafted|outreach_sent|response_received|conversation_started',
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
              final_text: 'Reach out to talent about the role.',
              source_draft_event_id: DRAFT_EVENT_ID,
            }),
            created_at: like('2026-05-25T10:01:00.000Z'),
          },
          delivery_id: like(DELIVERY_ID),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_ENGAGED}/outreach/send`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': K5,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(sendBody),
        });
        expect(res.status).toBe(200);
      });
  });

  it('422 ENGAGEMENT_REFERENCE_NOT_FOUND when draft_event_id does not resolve', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated and an engagement exists in engaged state for tenant')
      .uponReceiving('an outreach-send request with an unknown draft_event_id')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_ENGAGED}/outreach/send`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(K6),
          'Content-Type': 'application/json',
        }).jsonBody({ draft_event_id: DRAFT_EVENT_ID_UNKNOWN, final_text: 'Reach out.' });
      })
      .willRespondWith(422, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          error: {
            code: like('ENGAGEMENT_REFERENCE_NOT_FOUND'),
            message: like('draft_event_id not found, not in tenant, or not an outreach_drafted event'),
            request_id: uuid(REQUEST_ID),
            details: like({ field: 'draft_event_id' }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_ENGAGED}/outreach/send`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': K6,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ draft_event_id: DRAFT_EVENT_ID_UNKNOWN, final_text: 'Reach out.' }),
        });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('ENGAGEMENT_REFERENCE_NOT_FOUND');
      });
  });

  it('403 CONSENT_NOT_GRANTED_AT_SEND when contacting consent is revoked at send', async () => {
    await provider
      .addInteraction()
      .given('an engagement in engaged state with a prior outreach_drafted event but contacting consent revoked exists for the tenant')
      .uponReceiving('an outreach-send request when contacting consent is revoked')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_CONSENT_REVOKED}/outreach/send`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(K7),
          'Content-Type': 'application/json',
        }).jsonBody({ draft_event_id: DRAFT_EVENT_ID_REVOKED, final_text: 'Reach out.' });
      })
      .willRespondWith(403, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          error: {
            code: like('CONSENT_NOT_GRANTED_AT_SEND'),
            message: like('consent denied at send time'),
            request_id: uuid(REQUEST_ID),
            details: like({
              consent_decision: like({
                result: regex('allowed|denied|error', 'denied'),
                reason_code: like('stale_consent'),
                decision_id: uuid(DECISION_ID),
                computed_at: like('2026-05-27T10:00:00.000Z'),
              }),
              engagement_id: uuid(ENGAGEMENT_CONSENT_REVOKED),
            }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_CONSENT_REVOKED}/outreach/send`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': K7,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ draft_event_id: DRAFT_EVENT_ID_REVOKED, final_text: 'Reach out.' }),
        });
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('CONSENT_NOT_GRANTED_AT_SEND');
      });
  });

  it('403 INSUFFICIENT_PERMISSIONS with a portal JWT', async () => {
    await provider
      .addInteraction()
      .given('a portal user has authenticated against the outreach-send endpoint')
      .uponReceiving('an outreach-send request with a portal JWT')
      .withRequest('POST', `/v1/engagements/${ENGAGEMENT_ENGAGED}/outreach/send`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.portal.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(K8),
          'Content-Type': 'application/json',
        }).jsonBody({ draft_event_id: DRAFT_EVENT_ID, final_text: 'Reach out.' });
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
        const res = await fetch(`${mock.url}/v1/engagements/${ENGAGEMENT_ENGAGED}/outreach/send`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.portal.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': K8,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ draft_event_id: DRAFT_EVENT_ID, final_text: 'Reach out.' }),
        });
        expect(res.status).toBe(403);
      });
  });
});
