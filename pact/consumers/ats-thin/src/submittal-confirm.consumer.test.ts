import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, regex } = MatchersV3;

// M4 PR-4 §4.8 Pact consumer — POST /v1/submittals/{submittal_id}/confirm.
//
// Four interactions:
//   1) Entrustable + all attestations true → 200 + ConfirmSubmittalResponse
//      (strict shape with state='submitted', confirmed_at set).
//   2) attestation false → 422 ATTESTATION_MISSING.
//   3) newer examination exists → 409 EXAMINATION_PINNED_OUTDATED.
//   4) Worth Considering missing justification → 422 JUSTIFICATION_REQUIRED.
//
// Consumer: ats-thin. Provider: aramo-core (apps/api). State handlers
// extend pact/provider/src/verify-api.ts seedSubmittalFixture per §4.9.
//
// Locked invariants:
//   - 200 carries `submittal: TalentSubmittalRecord` with state='submitted'
//     and confirmed_at populated.
//   - 422 / 409 carry the AramoError envelope with the named code.
//   - X-Request-ID round-trips through every interaction.

const provider = new PactV4({
  consumer: 'ats-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const JOB_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const EXAM_ID_ENTRUSTABLE = '11110000-0000-7000-8000-0000000e0002';
const EXAM_ID_WC = '22220000-0000-7000-8000-0000000c0002';
const EXAM_ID_OUTDATED = '44440000-0000-7000-8000-0000000d0002';
const SUBMITTAL_ID_HAPPY = '99990000-0000-7000-8000-000000000901';
const SUBMITTAL_ID_OUTDATED = '99990000-0000-7000-8000-000000000902';
const SUBMITTAL_ID_WC = '99990000-0000-7000-8000-000000000903';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f10';
const IDEMPOTENCY_KEY_1 = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f11';
const IDEMPOTENCY_KEY_2 = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f12';
const IDEMPOTENCY_KEY_3 = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f13';
const IDEMPOTENCY_KEY_4 = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f14';

const ALL_TRUE = {
  attestations: {
    talent_evidence_reviewed: true,
    constraints_reviewed: true,
    submittal_risk_acknowledged: true,
  },
};

const ONE_FALSE = {
  attestations: {
    talent_evidence_reviewed: true,
    constraints_reviewed: true,
    submittal_risk_acknowledged: false,
  },
};

describe('ATS thin consumer → POST /v1/submittals/{id}/confirm', () => {
  it('confirms submittal returns 200 when all attestations true and pinned examination is current', async () => {
    await provider
      .addInteraction()
      .given(
        'a recruiter has authenticated, an Entrustable examination exists, and a draft submittal exists pinned to that examination',
      )
      .uponReceiving('a submittal-confirm request with all attestations true')
      .withRequest(
        'POST',
        `/v1/submittals/${SUBMITTAL_ID_HAPPY}/confirm`,
        (b) => {
          b.headers({
            Authorization: like('Bearer eyJfake.token'),
            'X-Request-ID': uuid(REQUEST_ID),
            'Idempotency-Key': uuid(IDEMPOTENCY_KEY_1),
            'Content-Type': 'application/json',
          }).jsonBody(ALL_TRUE);
        },
      )
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          submittal: {
            id: uuid(SUBMITTAL_ID_HAPPY),
            tenant_id: uuid(TENANT_ID),
            talent_id: uuid(TALENT_ID),
            job_id: uuid(JOB_ID),
            evidence_package_id: uuid(),
            pinned_examination_id: uuid(EXAM_ID_ENTRUSTABLE),
            state: regex('draft|submitted', 'submitted'),
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
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/submittals/${SUBMITTAL_ID_HAPPY}/confirm`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer eyJfake.token',
              'X-Request-ID': REQUEST_ID,
              'Idempotency-Key': IDEMPOTENCY_KEY_1,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(ALL_TRUE),
          },
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.submittal.state).toBe('submitted');
        expect(body.submittal.confirmed_at).not.toBeNull();
      });
  });

  it('rejects confirm returns 422 ATTESTATION_MISSING when any attestation false', async () => {
    await provider
      .addInteraction()
      .given(
        'a recruiter has authenticated, an Entrustable examination exists, and a draft submittal exists pinned to that examination',
      )
      .uponReceiving(
        'a submittal-confirm request with submittal_risk_acknowledged false',
      )
      .withRequest(
        'POST',
        `/v1/submittals/${SUBMITTAL_ID_HAPPY}/confirm`,
        (b) => {
          b.headers({
            Authorization: like('Bearer eyJfake.token'),
            'X-Request-ID': uuid(REQUEST_ID),
            'Idempotency-Key': uuid(IDEMPOTENCY_KEY_2),
            'Content-Type': 'application/json',
          }).jsonBody(ONE_FALSE);
        },
      )
      .willRespondWith(422, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          error: {
            code: regex('ATTESTATION_MISSING', 'ATTESTATION_MISSING'),
            message: like(
              'All three attestations must be true: talent_evidence_reviewed, constraints_reviewed, submittal_risk_acknowledged',
            ),
            request_id: uuid(REQUEST_ID),
            details: like({ submittal_id: SUBMITTAL_ID_HAPPY }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/submittals/${SUBMITTAL_ID_HAPPY}/confirm`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer eyJfake.token',
              'X-Request-ID': REQUEST_ID,
              'Idempotency-Key': IDEMPOTENCY_KEY_2,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(ONE_FALSE),
          },
        );
        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body.error.code).toBe('ATTESTATION_MISSING');
      });
  });

  it('rejects confirm returns 409 EXAMINATION_PINNED_OUTDATED when newer examination exists', async () => {
    await provider
      .addInteraction()
      .given(
        'a recruiter has authenticated, a draft submittal exists, and a newer examination has been generated for the same talent/job after the pinning',
      )
      .uponReceiving(
        'a submittal-confirm request against a stale pinned examination',
      )
      .withRequest(
        'POST',
        `/v1/submittals/${SUBMITTAL_ID_OUTDATED}/confirm`,
        (b) => {
          b.headers({
            Authorization: like('Bearer eyJfake.token'),
            'X-Request-ID': uuid(REQUEST_ID),
            'Idempotency-Key': uuid(IDEMPOTENCY_KEY_3),
            'Content-Type': 'application/json',
          }).jsonBody(ALL_TRUE);
        },
      )
      .willRespondWith(409, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          error: {
            code: regex(
              'EXAMINATION_PINNED_OUTDATED',
              'EXAMINATION_PINNED_OUTDATED',
            ),
            message: like('Newer examination exists; recruiter must refresh draft'),
            request_id: uuid(REQUEST_ID),
            details: like({
              submittal_id: SUBMITTAL_ID_OUTDATED,
              pinned_examination_id: EXAM_ID_OUTDATED,
            }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/submittals/${SUBMITTAL_ID_OUTDATED}/confirm`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer eyJfake.token',
              'X-Request-ID': REQUEST_ID,
              'Idempotency-Key': IDEMPOTENCY_KEY_3,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(ALL_TRUE),
          },
        );
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.error.code).toBe('EXAMINATION_PINNED_OUTDATED');
      });
  });

  it('rejects confirm returns 422 JUSTIFICATION_REQUIRED for Worth Considering with no justification', async () => {
    await provider
      .addInteraction()
      .given(
        'a recruiter has authenticated, a Worth Considering examination exists, and a draft submittal exists without justification',
      )
      .uponReceiving(
        'a submittal-confirm request against a Worth Considering draft missing justification',
      )
      .withRequest(
        'POST',
        `/v1/submittals/${SUBMITTAL_ID_WC}/confirm`,
        (b) => {
          b.headers({
            Authorization: like('Bearer eyJfake.token'),
            'X-Request-ID': uuid(REQUEST_ID),
            'Idempotency-Key': uuid(IDEMPOTENCY_KEY_4),
            'Content-Type': 'application/json',
          }).jsonBody(ALL_TRUE);
        },
      )
      .willRespondWith(422, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          error: {
            code: regex('JUSTIFICATION_REQUIRED', 'JUSTIFICATION_REQUIRED'),
            message: like(
              'Worth Considering submittals require non-empty justification',
            ),
            request_id: uuid(REQUEST_ID),
            details: like({
              submittal_id: SUBMITTAL_ID_WC,
              missing_field: 'justification',
            }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/submittals/${SUBMITTAL_ID_WC}/confirm`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer eyJfake.token',
              'X-Request-ID': REQUEST_ID,
              'Idempotency-Key': IDEMPOTENCY_KEY_4,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(ALL_TRUE),
          },
        );
        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body.error.code).toBe('JUSTIFICATION_REQUIRED');
      });
  });
});

// Suppress unused-constant warnings — these are documentation-only.
void EXAM_ID_ENTRUSTABLE;
void EXAM_ID_WC;
