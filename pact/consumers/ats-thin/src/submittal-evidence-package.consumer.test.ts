import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, regex } = MatchersV3;

// M4 PR-6 §4.5 Pact consumer — GET /v1/submittals/{submittal_id}/
// evidence-package.
//
// Two interactions:
//   1) Submittal + linked TalentJobEvidencePackage exist → 200 +
//      TalentJobEvidencePackageView (strict shape; all 5 JSONB payloads
//      populated + engagement_event_refs[]).
//   2) Submittal does not exist → 404 NOT_FOUND (AramoError envelope).
//
// Consumer: ats-thin (recruiter-facing).
// Provider: aramo-core (apps/api). State handlers:
//   - seedSubmittalForEvidencePackageFixture (verify-api.ts).
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
const EXAM_ID = '11110000-0000-7000-8000-0000000e0007';
const SUBMITTAL_ID_HAPPY = '99990000-0000-7000-8000-000000000907';
const EVIDENCE_PKG_ID_HAPPY = '99990000-0000-7000-8000-0000000010a7';
const SUBMITTAL_ID_MISSING = '99990000-0000-7000-8000-0000000009fe';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b6100';

describe('ATS thin consumer → GET /v1/submittals/{submittal_id}/evidence-package', () => {
  it('returns 200 with TalentJobEvidencePackageView when submittal and linked package exist', async () => {
    await provider
      .addInteraction()
      .given(
        'a recruiter has authenticated and a TalentSubmittalRecord + linked TalentJobEvidencePackage exist for the tenant',
      )
      .uponReceiving(
        'a get-evidence-package request for an existing submittal',
      )
      .withRequest(
        'GET',
        `/v1/submittals/${SUBMITTAL_ID_HAPPY}/evidence-package`,
        (b) => {
          b.headers({
            Authorization: like('Bearer eyJfake.token'),
            'X-Request-ID': uuid(REQUEST_ID),
          });
        },
      )
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          id: uuid(EVIDENCE_PKG_ID_HAPPY),
          tenant_id: uuid(TENANT_ID),
          talent_id: uuid(TALENT_ID),
          job_id: uuid(JOB_ID),
          examination_id: uuid(EXAM_ID),
          submittal_record_id: uuid(SUBMITTAL_ID_HAPPY),
          parent_package_id: null,
          talent_identity: like({
            full_name: 'Pact Talent',
            location: 'Remote (US)',
          }),
          contact_summary: like({
            contact_available: true,
            channels_verified: ['email'],
          }),
          capability_summary: like({
            key_work_history: [
              {
                employer_name: 'Acme',
                role_title: 'Senior Engineer',
              },
            ],
          }),
          match_justification: like({
            why_this_talent: 'Pact-seeded sample.',
          }),
          recruiter_contribution: like({
            conversation_summary: {
              recruiter_summary: 'Discussed.',
            },
            talent_confirmed: { spoken_to_recruiter: true },
          }),
          engagement_event_refs: [],
          created_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
            '2026-05-23T12:00:00Z',
          ),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/submittals/${SUBMITTAL_ID_HAPPY}/evidence-package`,
          {
            method: 'GET',
            headers: {
              Authorization: 'Bearer eyJfake.token',
              'X-Request-ID': REQUEST_ID,
            },
          },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body['id']).toBe(EVIDENCE_PKG_ID_HAPPY);
        expect(body['tenant_id']).toBe(TENANT_ID);
        expect(body['examination_id']).toBe(EXAM_ID);
        expect(body['submittal_record_id']).toBe(SUBMITTAL_ID_HAPPY);
      });
  });

  it('returns 404 NOT_FOUND when submittal does not exist', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated')
      .uponReceiving(
        'a get-evidence-package request for a non-existent submittal',
      )
      .withRequest(
        'GET',
        `/v1/submittals/${SUBMITTAL_ID_MISSING}/evidence-package`,
        (b) => {
          b.headers({
            Authorization: like('Bearer eyJfake.token'),
            'X-Request-ID': uuid(REQUEST_ID),
          });
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
          `${mock.url}/v1/submittals/${SUBMITTAL_ID_MISSING}/evidence-package`,
          {
            method: 'GET',
            headers: {
              Authorization: 'Bearer eyJfake.token',
              'X-Request-ID': REQUEST_ID,
            },
          },
        );
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('NOT_FOUND');
      });
  });
});
