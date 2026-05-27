import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, regex } = MatchersV3;

// M4 PR-6 §4.5 Pact consumer — GET /v1/submittals/{submittal_id}.
//
// Two interactions:
//   1) Submittal exists → 200 + TalentSubmittalRecord (strict shape).
//   2) Submittal does not exist → 404 NOT_FOUND (AramoError envelope).
//
// Consumer: ats-thin (recruiter-facing).
// Provider: aramo-core (apps/api). State handlers:
//   - seedSubmittalForGetFixture (pact/provider/src/verify-api.ts).
//
// No Idempotency-Key (Ruling 8 — GET routes don't require it).
// No state-isolation invariant (read-only endpoint).

const provider = new PactV4({
  consumer: 'ats-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const JOB_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const EXAM_ID = '11110000-0000-7000-8000-0000000e0006';
const SUBMITTAL_ID_HAPPY = '99990000-0000-7000-8000-000000000906';
const SUBMITTAL_ID_MISSING = '99990000-0000-7000-8000-0000000009ff';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b6000';

describe('ATS thin consumer → GET /v1/submittals/{submittal_id}', () => {
  it('returns 200 with TalentSubmittalRecord when submittal exists for the tenant', async () => {
    await provider
      .addInteraction()
      .given(
        'a recruiter has authenticated and a TalentSubmittalRecord exists for the tenant',
      )
      .uponReceiving('a get-submittal request for an existing submittal')
      .withRequest('GET', `/v1/submittals/${SUBMITTAL_ID_HAPPY}`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
        });
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          id: uuid(SUBMITTAL_ID_HAPPY),
          tenant_id: uuid(TENANT_ID),
          talent_id: uuid(TALENT_ID),
          job_id: uuid(JOB_ID),
          evidence_package_id: uuid(),
          pinned_examination_id: uuid(EXAM_ID),
          state: regex('created|handoff_draft', 'created'),
          created_by: uuid(),
          justification: null,
          failed_criterion_acknowledgments: null,
          created_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
            '2026-05-23T12:00:00Z',
          ),
          confirmed_at: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/submittals/${SUBMITTAL_ID_HAPPY}`,
          {
            method: 'GET',
            headers: {
              Authorization: 'Bearer eyJfake.token',
              'X-Request-ID': REQUEST_ID,
            },
          },
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.id).toBe(SUBMITTAL_ID_HAPPY);
        expect(body.tenant_id).toBe(TENANT_ID);
        expect(body.state).toBe('created');
      });
  });

  it('returns 404 NOT_FOUND when submittal does not exist', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated')
      .uponReceiving('a get-submittal request for a non-existent submittal')
      .withRequest('GET', `/v1/submittals/${SUBMITTAL_ID_MISSING}`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
        });
      })
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
          `${mock.url}/v1/submittals/${SUBMITTAL_ID_MISSING}`,
          {
            method: 'GET',
            headers: {
              Authorization: 'Bearer eyJfake.token',
              'X-Request-ID': REQUEST_ID,
            },
          },
        );
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error.code).toBe('NOT_FOUND');
      });
  });
});
