import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, regex } = MatchersV3;

// M5 PR-8b2 §4.12 Pact consumer — POST
// /v1/submittals/{submittal_id}/confirm-ats.
//
// Three interactions:
//   1) Submittal in state='submitted_to_ats' + empty body → 200 +
//      ConfirmAtsResponse (strict shape with state='confirmed';
//      lifecycle terminal per Ruling 5).
//   2) Submittal in state='created' (NOT submitted_to_ats) → 422
//      SUBMITTAL_STATE_INVALID.
//   3) submittal_id not seeded → 404 NOT_FOUND.

const provider = new PactV4({
  consumer: 'ats-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const SUBMITTAL_ID_HAPPY = '99990000-0000-7000-8000-000000000971';
const SUBMITTAL_ID_INVALID_STATE = '99990000-0000-7000-8000-000000000972';
const SUBMITTAL_ID_MISSING = '99990000-0000-7000-8000-0000000009fc';

const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b8300';
const IDEMPOTENCY_KEY_1 = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b8301';
const IDEMPOTENCY_KEY_2 = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b8302';
const IDEMPOTENCY_KEY_3 = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b8303';

// Process Lesson 67 workaround: pact-rust does NOT serialize empty {}
// bodies in a way NestJS body-parser can complete. The `_placeholder`
// field is internal to the Pact test infrastructure; controllers do
// not reference it. OpenAPI contract preserves "empty body" per Ruling
// 13 at the schema level. See submittal-mark-ready.consumer.test.ts
// for full PL-67 documentation.
const EMPTY_BODY = { _placeholder: true };

describe('ATS thin consumer → POST /v1/submittals/{id}/confirm-ats', () => {
  it('confirms ATS returns 200 with state=confirmed (terminal) when submittal is in submitted_to_ats state', async () => {
    await provider
      .addInteraction()
      .given(
        'a recruiter has authenticated and a TalentSubmittalRecord in submitted_to_ats state exists for the tenant',
      )
      .uponReceiving(
        'a submittal-confirm-ats request against a submitted_to_ats submittal',
      )
      .withRequest(
        'POST',
        `/v1/submittals/${SUBMITTAL_ID_HAPPY}/confirm-ats`,
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
              'confirmed',
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
              from_state: 'submitted_to_ats',
              to_state: 'confirmed',
            }),
            created_at: regex(
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
              '2026-05-22T14:00:00Z',
            ),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/submittals/${SUBMITTAL_ID_HAPPY}/confirm-ats`,
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
          submittal: { state: string };
        };
        expect(body.submittal.state).toBe('confirmed');
      });
  });

  it('rejects confirm-ats returns 422 SUBMITTAL_STATE_INVALID when submittal is in created state', async () => {
    await provider
      .addInteraction()
      .given(
        'a recruiter has authenticated and a TalentSubmittalRecord in created state exists for the tenant',
      )
      .uponReceiving(
        'a submittal-confirm-ats request against a created submittal',
      )
      .withRequest(
        'POST',
        `/v1/submittals/${SUBMITTAL_ID_INVALID_STATE}/confirm-ats`,
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
            message: like('Illegal submittal state transition: created -> confirmed'),
            request_id: uuid(REQUEST_ID),
            details: like({
              submittal_id: SUBMITTAL_ID_INVALID_STATE,
              from_state: 'created',
              to_state: 'confirmed',
            }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/submittals/${SUBMITTAL_ID_INVALID_STATE}/confirm-ats`,
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
        'a recruiter has authenticated and the submittal-confirm-ats target does not exist for the tenant',
      )
      .uponReceiving(
        'a submittal-confirm-ats request against a non-existent submittal',
      )
      .withRequest(
        'POST',
        `/v1/submittals/${SUBMITTAL_ID_MISSING}/confirm-ats`,
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
          `${mock.url}/v1/submittals/${SUBMITTAL_ID_MISSING}/confirm-ats`,
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
});
