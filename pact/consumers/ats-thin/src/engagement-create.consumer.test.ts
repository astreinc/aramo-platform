import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, regex } = MatchersV3;

// M5 PR-4 §4.8 — Pact consumer for POST /v1/engagements.
// 4 interactions: happy + Pattern C refusal + auth refusal + idempotency conflict.

const provider = new PactV4({
  consumer: 'ats-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const REQ_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const GHOST_TALENT = '99999999-9999-7999-8999-999999999991';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-cccc00000c01';
const IDEMPOTENCY_KEY_1 = '0190d5a4-7e01-7e2a-a4d3-cccc00000c11';
const IDEMPOTENCY_KEY_2 = '0190d5a4-7e01-7e2a-a4d3-cccc00000c12';
const IDEMPOTENCY_KEY_3 = '0190d5a4-7e01-7e2a-a4d3-cccc00000c13';
const IDEMPOTENCY_KEY_4 = '0190d5a4-7e01-7e2a-a4d3-cccc00000c14';

describe('ATS thin consumer → POST /v1/engagements', () => {
  it('returns 201 with engagement view when create succeeds for tenant', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated and a Talent + overlay + Requisition exist in tenant for engagement creation')
      .uponReceiving('an engagement-create request with valid talent + requisition')
      .withRequest('POST', '/v1/engagements', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY_1),
          'Content-Type': 'application/json',
        }).jsonBody({ talent_id: uuid(TALENT_ID), requisition_id: uuid(REQ_ID) });
      })
      .willRespondWith(201, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          engagement: {
            id: uuid(),
            tenant_id: uuid(TENANT_ID),
            talent_id: uuid(TALENT_ID),
            requisition_id: uuid(REQ_ID),
            examination_id: null,
            state: regex(
              'surfaced|evaluated|engaged|maybe|passed|awaiting_response|responded|in_conversation|not_interested|ready_for_submittal|submitted',
              'surfaced',
            ),
            created_at: like('2026-05-25T10:00:00.000Z'),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': IDEMPOTENCY_KEY_1,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ talent_id: TALENT_ID, requisition_id: REQ_ID }),
        });
        expect(res.status).toBe(201);
      });
  });

  it('returns 422 ENGAGEMENT_REFERENCE_NOT_FOUND when talent not visible in tenant', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated but the talent has no overlay in tenant')
      .uponReceiving('an engagement-create request with a talent_id not visible in tenant')
      .withRequest('POST', '/v1/engagements', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY_2),
          'Content-Type': 'application/json',
        }).jsonBody({ talent_id: uuid(GHOST_TALENT), requisition_id: uuid(REQ_ID) });
      })
      .willRespondWith(422, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          error: {
            code: like('ENGAGEMENT_REFERENCE_NOT_FOUND'),
            message: like('Talent not visible in tenant'),
            request_id: uuid(REQUEST_ID),
            details: like({ field: 'talent_id' }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': IDEMPOTENCY_KEY_2,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ talent_id: GHOST_TALENT, requisition_id: REQ_ID }),
        });
        expect(res.status).toBe(422);
      });
  });

  it('returns 403 INSUFFICIENT_PERMISSIONS with a portal JWT', async () => {
    await provider
      .addInteraction()
      .given('a portal user has authenticated against the engagement-create endpoint')
      .uponReceiving('an engagement-create request with a portal JWT')
      .withRequest('POST', '/v1/engagements', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.portal.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY_3),
          'Content-Type': 'application/json',
        }).jsonBody({ talent_id: uuid(TALENT_ID), requisition_id: uuid(REQ_ID) });
      })
      .willRespondWith(403, (b) => {
        // R7 BE-prereq: the 403 for portal-JWT now fires at the
        // RolesGuard layer (scope-missing) BEFORE the controller's
        // assertConsumerIsRecruiter (which used to populate
        // details.consumer_type). The contract surface — 403 +
        // INSUFFICIENT_PERMISSIONS + matching request_id — is
        // preserved; details is implementation-specific and dropped
        // from the contract.
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          error: {
            code: like('INSUFFICIENT_PERMISSIONS'),
            message: like('Required scopes not granted'),
            request_id: uuid(REQUEST_ID),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.portal.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': IDEMPOTENCY_KEY_3,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ talent_id: TALENT_ID, requisition_id: REQ_ID }),
        });
        expect(res.status).toBe(403);
      });
  });

  it('returns 409 IDEMPOTENCY_KEY_CONFLICT when same key + different body', async () => {
    await provider
      .addInteraction()
      .given('an idempotency key has been used for a prior engagement-create with a different body')
      .uponReceiving('an engagement-create request with a colliding idempotency key')
      .withRequest('POST', '/v1/engagements', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY_4),
          'Content-Type': 'application/json',
        }).jsonBody({ talent_id: uuid(TALENT_ID), requisition_id: uuid(REQ_ID) });
      })
      .willRespondWith(409, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          error: {
            code: like('IDEMPOTENCY_KEY_CONFLICT'),
            message: like('Same idempotency key used with a different request body'),
            request_id: uuid(REQUEST_ID),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': IDEMPOTENCY_KEY_4,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ talent_id: TALENT_ID, requisition_id: REQ_ID }),
        });
        expect(res.status).toBe(409);
      });
  });

  // M5 PR-9 §4.1 — formal idempotency replay + conflict per Plan v1.5 §M5 Track B item 2.
  const REPLAY_KEY = '0190d5a4-7e01-7e2a-a4d3-cccc00000c20';
  const CONFLICT_KEY_PR9 = '0190d5a4-7e01-7e2a-a4d3-cccc00000c21';

  it('idempotency replay: same key + same body returns cached 201 response', async () => {
    await provider
      .addInteraction()
      .given('an idempotency key has been recorded with a prior engagement-create response')
      .uponReceiving('an engagement-create request replaying a prior key + body')
      .withRequest('POST', '/v1/engagements', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(REPLAY_KEY),
          'Content-Type': 'application/json',
        }).jsonBody({ talent_id: TALENT_ID, requisition_id: REQ_ID });
      })
      .willRespondWith(201, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          engagement: like({ id: uuid(), state: 'surfaced' }),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/engagements`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': REPLAY_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ talent_id: TALENT_ID, requisition_id: REQ_ID }),
        });
        expect(res.status).toBe(201);
      });
  });

  it('idempotency conflict (PR-9 formal): same key + different body returns 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
    await provider
      .addInteraction()
      .given('an idempotency key has been recorded with a different engagement-create body (PR-9)')
      .uponReceiving('an engagement-create request with a PR-9 conflicting prior key')
      .withRequest('POST', '/v1/engagements', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(CONFLICT_KEY_PR9),
          'Content-Type': 'application/json',
        }).jsonBody({ talent_id: TALENT_ID, requisition_id: REQ_ID });
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
        const res = await fetch(`${mock.url}/v1/engagements`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': CONFLICT_KEY_PR9,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ talent_id: TALENT_ID, requisition_id: REQ_ID }),
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      });
  });
});
