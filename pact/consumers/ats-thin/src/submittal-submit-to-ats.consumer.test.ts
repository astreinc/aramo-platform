import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, regex } = MatchersV3;

// M5 PR-8b2 §4.12 Pact consumer — POST
// /v1/submittals/{submittal_id}/submit-to-ats.
//
// Three interactions:
//   1) Submittal in state='ready_for_review' + empty body → 200 +
//      SubmitToAtsResponse (strict shape with state='submitted_to_ats',
//      confirmed_at populated per Ruling 6).
//   2) Submittal in state='created' (NOT ready_for_review) → 422
//      SUBMITTAL_STATE_INVALID.
//   3) submittal_id not seeded → 404 NOT_FOUND.

const provider = new PactV4({
  consumer: 'ats-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const SUBMITTAL_ID_HAPPY = '99990000-0000-7000-8000-000000000961';
const SUBMITTAL_ID_INVALID_STATE = '99990000-0000-7000-8000-000000000962';
const SUBMITTAL_ID_MISSING = '99990000-0000-7000-8000-0000000009fd';

const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b8200';
const IDEMPOTENCY_KEY_1 = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b8201';
const IDEMPOTENCY_KEY_2 = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b8202';
const IDEMPOTENCY_KEY_3 = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b8203';

// Process Lesson 67 workaround: pact-rust does NOT serialize empty {}
// bodies in a way NestJS body-parser can complete. The `_placeholder`
// field is internal to the Pact test infrastructure; controllers do
// not reference it. OpenAPI contract preserves "empty body" per Ruling
// 13 at the schema level. See submittal-mark-ready.consumer.test.ts
// for full PL-67 documentation.
const EMPTY_BODY = { _placeholder: true };

describe('ATS thin consumer → POST /v1/submittals/{id}/submit-to-ats', () => {
  it('submits to ATS returns 200 with state=submitted_to_ats + confirmed_at populated when submittal is in ready_for_review state', async () => {
    await provider
      .addInteraction()
      .given(
        'a recruiter has authenticated and a TalentSubmittalRecord in ready_for_review state exists for the tenant',
      )
      .uponReceiving(
        'a submittal-submit-to-ats request against a ready_for_review submittal',
      )
      .withRequest(
        'POST',
        `/v1/submittals/${SUBMITTAL_ID_HAPPY}/submit-to-ats`,
        (b) => {
          b.headers({
            Authorization: like('Bearer eyJfake.token'),
            'X-Request-ID': uuid(REQUEST_ID),
            'Idempotency-Key': uuid(IDEMPOTENCY_KEY_1),
            'Content-Type': 'application/json',
          }).jsonBody(EMPTY_BODY);
        },
      )
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          submittal: {
            id: uuid(SUBMITTAL_ID_HAPPY),
            tenant_id: uuid(TENANT_ID),
            talent_id: uuid(),
            job_id: uuid(),
            evidence_package_id: uuid(),
            pinned_examination_id: uuid(),
            state: regex(
              'created|handoff_draft|ready_for_review|submitted_to_ats|confirmed|revoked',
              'submitted_to_ats',
            ),
            created_by: uuid(),
            justification: null,
            failed_criterion_acknowledgments: null,
            created_at: regex(
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
              '2026-05-22T12:00:00Z',
            ),
            confirmed_at: regex(
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
              '2026-05-22T13:00:00Z',
            ),
            revoked_at: null,
            revoked_by: null,
            revocation_justification: null,
          },
          event: {
            id: uuid(),
            tenant_id: uuid(TENANT_ID),
            submittal_id: uuid(SUBMITTAL_ID_HAPPY),
            event_type: regex('state_transition', 'state_transition'),
            event_payload: like({
              from_state: 'ready_for_review',
              to_state: 'submitted_to_ats',
            }),
            created_at: regex(
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
              '2026-05-22T13:00:00Z',
            ),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/submittals/${SUBMITTAL_ID_HAPPY}/submit-to-ats`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer eyJfake.token',
              'X-Request-ID': REQUEST_ID,
              'Idempotency-Key': IDEMPOTENCY_KEY_1,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(EMPTY_BODY),
          },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          submittal: { state: string; confirmed_at: string | null };
        };
        expect(body.submittal.state).toBe('submitted_to_ats');
        expect(body.submittal.confirmed_at).not.toBeNull();
      });
  });

  it('rejects submit-to-ats returns 422 SUBMITTAL_STATE_INVALID when submittal is in created state', async () => {
    await provider
      .addInteraction()
      .given(
        'a recruiter has authenticated and a TalentSubmittalRecord in created state exists for the tenant',
      )
      .uponReceiving(
        'a submittal-submit-to-ats request against a created submittal',
      )
      .withRequest(
        'POST',
        `/v1/submittals/${SUBMITTAL_ID_INVALID_STATE}/submit-to-ats`,
        (b) => {
          b.headers({
            Authorization: like('Bearer eyJfake.token'),
            'X-Request-ID': uuid(REQUEST_ID),
            'Idempotency-Key': uuid(IDEMPOTENCY_KEY_2),
            'Content-Type': 'application/json',
          }).jsonBody(EMPTY_BODY);
        },
      )
      .willRespondWith(422, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          error: {
            code: regex('SUBMITTAL_STATE_INVALID', 'SUBMITTAL_STATE_INVALID'),
            message: like('Illegal submittal state transition: created -> submitted_to_ats'),
            request_id: uuid(REQUEST_ID),
            details: like({
              submittal_id: SUBMITTAL_ID_INVALID_STATE,
              from_state: 'created',
              to_state: 'submitted_to_ats',
            }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/submittals/${SUBMITTAL_ID_INVALID_STATE}/submit-to-ats`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer eyJfake.token',
              'X-Request-ID': REQUEST_ID,
              'Idempotency-Key': IDEMPOTENCY_KEY_2,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(EMPTY_BODY),
          },
        );
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('SUBMITTAL_STATE_INVALID');
      });
  });

  it('returns 404 NOT_FOUND when submittal does not exist', async () => {
    await provider
      .addInteraction()
      .given(
        'a recruiter has authenticated and the submittal-submit-to-ats target does not exist for the tenant',
      )
      .uponReceiving(
        'a submittal-submit-to-ats request against a non-existent submittal',
      )
      .withRequest(
        'POST',
        `/v1/submittals/${SUBMITTAL_ID_MISSING}/submit-to-ats`,
        (b) => {
          b.headers({
            Authorization: like('Bearer eyJfake.token'),
            'X-Request-ID': uuid(REQUEST_ID),
            'Idempotency-Key': uuid(IDEMPOTENCY_KEY_3),
            'Content-Type': 'application/json',
          }).jsonBody(EMPTY_BODY);
        },
      )
      .willRespondWith(404, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          error: {
            code: regex('NOT_FOUND', 'NOT_FOUND'),
            message: like('TalentSubmittalRecord not found'),
            request_id: uuid(REQUEST_ID),
            details: like({ submittal_id: SUBMITTAL_ID_MISSING }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/submittals/${SUBMITTAL_ID_MISSING}/submit-to-ats`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer eyJfake.token',
              'X-Request-ID': REQUEST_ID,
              'Idempotency-Key': IDEMPOTENCY_KEY_3,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(EMPTY_BODY),
          },
        );
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('NOT_FOUND');
      });
  });

  // M5 PR-9 §4.1 — idempotency replay + conflict per Plan v1.5 §M5 Track B item 2.
  const REPLAY_KEY = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b8210';
  const CONFLICT_KEY = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b8211';

  it('idempotency replay: same key + same body returns cached 200 response', async () => {
    await provider
      .addInteraction()
      .given('an idempotency key has been recorded with a prior submittal-submit-to-ats response')
      .uponReceiving('a submittal-submit-to-ats request replaying a prior key + body')
      .withRequest('POST', `/v1/submittals/${SUBMITTAL_ID_HAPPY}/submit-to-ats`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(REPLAY_KEY),
          'Content-Type': 'application/json',
        }).jsonBody(EMPTY_BODY);
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          submittal: like({ id: SUBMITTAL_ID_HAPPY, state: 'submitted_to_ats' }),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals/${SUBMITTAL_ID_HAPPY}/submit-to-ats`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': REPLAY_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(EMPTY_BODY),
        });
        expect(res.status).toBe(200);
      });
  });

  it('idempotency conflict: same key + different body returns 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
    await provider
      .addInteraction()
      .given('an idempotency key has been recorded with a different submittal-submit-to-ats body')
      .uponReceiving('a submittal-submit-to-ats request with a conflicting prior key')
      .withRequest('POST', `/v1/submittals/${SUBMITTAL_ID_HAPPY}/submit-to-ats`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(CONFLICT_KEY),
          'Content-Type': 'application/json',
        }).jsonBody(EMPTY_BODY);
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
        const res = await fetch(`${mock.url}/v1/submittals/${SUBMITTAL_ID_HAPPY}/submit-to-ats`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': CONFLICT_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(EMPTY_BODY),
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      });
  });
});
