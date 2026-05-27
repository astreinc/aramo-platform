import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, regex } = MatchersV3;

// M5 PR-8b2 §4.12 Pact consumer — POST
// /v1/submittals/{submittal_id}/mark-ready.
//
// Three interactions per directive §4.12:
//   1) Submittal in state='handoff_draft' + empty body → 200 +
//      MarkReadyResponse (strict shape with state='ready_for_review',
//      event emitted with payload { from_state, to_state }).
//   2) Submittal in state='created' (NOT handoff_draft) → 422
//      SUBMITTAL_STATE_INVALID with from_state + to_state in details.
//   3) submittal_id not seeded → 404 NOT_FOUND.
//
// Consumer: ats-thin (recruiter-facing).
// Provider: aramo-core (apps/api). State handlers extend
// pact/provider/src/verify-api.ts seedSubmittalRevokeFixture per §4.13
// (the fixture seeds the submittal at the requested submittalState
// using the canonical 5-state chain).
//
// Locked invariants asserted:
//   - 200 response carries { submittal, event } per Ruling 14:
//     submittal in canonical 'ready_for_review' state + event
//     state_transition payload.
//   - 422 / 404 carry the AramoError envelope with the named code.
//   - Empty request body per Ruling 13.
//   - X-Request-ID header round-trips through every interaction.

const provider = new PactV4({
  consumer: 'ats-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const SUBMITTAL_ID_HAPPY = '99990000-0000-7000-8000-000000000951';
const SUBMITTAL_ID_INVALID_STATE = '99990000-0000-7000-8000-000000000952';
const SUBMITTAL_ID_MISSING = '99990000-0000-7000-8000-0000000009fe';

const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b8100';
const IDEMPOTENCY_KEY_1 = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b8101';
const IDEMPOTENCY_KEY_2 = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b8102';
const IDEMPOTENCY_KEY_3 = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b8103';

// Process Lesson 67 workaround: pact-rust does NOT serialize empty {}
// bodies in a way NestJS body-parser can complete (server hangs in
// pre-handler body parsing for 30s; controller handler never invoked).
// The `_placeholder` field is internal to the Pact test infrastructure;
// the SubmittalController.markReady handler does not reference it.
// OpenAPI contract preserves "empty body" per Ruling 13 at the schema
// level. Production HTTP clients can send genuine {} bodies without
// issue — the bug is specific to pact-rust wire serialization.
const EMPTY_BODY = { _placeholder: true };

describe('ATS thin consumer → POST /v1/submittals/{id}/mark-ready', () => {
  it('marks ready returns 200 with state=ready_for_review when submittal is in handoff_draft state', async () => {
    await provider
      .addInteraction()
      .given(
        'a recruiter has authenticated and a TalentSubmittalRecord in handoff_draft state exists for the tenant',
      )
      .uponReceiving(
        'a submittal-mark-ready request against a handoff_draft submittal',
      )
      .withRequest(
        'POST',
        `/v1/submittals/${SUBMITTAL_ID_HAPPY}/mark-ready`,
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
              'ready_for_review',
            ),
            created_by: uuid(),
            justification: null,
            failed_criterion_acknowledgments: null,
            created_at: regex(
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
              '2026-05-22T12:00:00Z',
            ),
            confirmed_at: null,
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
              from_state: 'handoff_draft',
              to_state: 'ready_for_review',
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
          `${mock.url}/v1/submittals/${SUBMITTAL_ID_HAPPY}/mark-ready`,
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
          event: { event_type: string };
        };
        expect(body.submittal.state).toBe('ready_for_review');
        expect(body.event.event_type).toBe('state_transition');
      });
  });

  it('rejects mark-ready returns 422 SUBMITTAL_STATE_INVALID when submittal is in created state', async () => {
    await provider
      .addInteraction()
      .given(
        'a recruiter has authenticated and a TalentSubmittalRecord in created state exists for the tenant',
      )
      .uponReceiving(
        'a submittal-mark-ready request against a created submittal',
      )
      .withRequest(
        'POST',
        `/v1/submittals/${SUBMITTAL_ID_INVALID_STATE}/mark-ready`,
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
            message: like('Illegal submittal state transition: created -> ready_for_review'),
            request_id: uuid(REQUEST_ID),
            details: like({
              submittal_id: SUBMITTAL_ID_INVALID_STATE,
              from_state: 'created',
              to_state: 'ready_for_review',
            }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/submittals/${SUBMITTAL_ID_INVALID_STATE}/mark-ready`,
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
        'a recruiter has authenticated and the submittal-mark-ready target does not exist for the tenant',
      )
      .uponReceiving(
        'a submittal-mark-ready request against a non-existent submittal',
      )
      .withRequest(
        'POST',
        `/v1/submittals/${SUBMITTAL_ID_MISSING}/mark-ready`,
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
          `${mock.url}/v1/submittals/${SUBMITTAL_ID_MISSING}/mark-ready`,
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
