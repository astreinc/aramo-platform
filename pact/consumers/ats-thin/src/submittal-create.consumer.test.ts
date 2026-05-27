import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, regex, eachLike, boolean } = MatchersV3;

// M4 PR-3 §4.7 Pact consumer — POST /v1/submittals.
//
// Two interactions:
//   1) Entrustable tier → 201 + CreateSubmittalResponse (strict shape).
//   2) Stretch tier → 422 SUBMITTAL_STRETCH_BLOCKED (AramoError envelope).
//
// Consumer: ats-thin (recruiter-facing).
// Provider: aramo-core (apps/api). State handler: seedSubmittalFixture
// (pact/provider/src/verify-api.ts).
//
// Locked invariants asserted:
//   - 201 response carries `submittal: TalentSubmittalRecord` with
//     state='created' (M5 PR-8b2 rename: M4 'draft' renames to canonical
//     'created') and confirmed_at=null (the create endpoint does NOT
//     transition state).
//   - 422 refusal carries the AramoError envelope with code
//     SUBMITTAL_STRETCH_BLOCKED.
//   - X-Request-ID header round-tripped.

const provider = new PactV4({
  consumer: 'ats-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const JOB_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const EXAM_ID_ENTRUSTABLE = '11110000-0000-7000-8000-0000000e0001';
const EXAM_ID_STRETCH = '33330000-0000-7000-8000-0000000a0001';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f00';
const IDEMPOTENCY_KEY = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f01';
const SUBMITTAL_ID_REPLAY = '99990000-0000-7000-8000-000000000d01';

const VALID_BODY_ENTRUSTABLE = {
  talent_id: TALENT_ID,
  job_id: JOB_ID,
  examination_id: EXAM_ID_ENTRUSTABLE,
  talent_identity: {
    full_name: 'Sample Talent',
    preferred_name: 'Sam',
    location: 'Remote (US)',
  },
  contact_summary: {
    contact_available: true,
    channels_verified: ['email'],
  },
  capability_summary_overrides: {
    key_work_history: [
      {
        employer_name: 'Acme Corp',
        role_title: 'Senior Engineer',
        start_date: '2021-01-01',
      },
    ],
    certifications: ['AWS Solutions Architect'],
  },
  recruiter_contribution: {
    screening_notes: 'Spoke 2026-05-22.',
    conversation_summary: {
      recruiter_summary: 'Discussed role, fit, and timing.',
    },
    talent_confirmed: {
      spoken_to_recruiter: true,
    },
  },
};

const VALID_BODY_STRETCH = {
  ...VALID_BODY_ENTRUSTABLE,
  examination_id: EXAM_ID_STRETCH,
};

describe('ATS thin consumer → POST /v1/submittals', () => {
  it('creates submittal returns 201 and submittal_id when tier is Entrustable', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated and there is an Entrustable examination for the talent and job')
      .uponReceiving('a create-submittal request for an Entrustable examination')
      .withRequest('POST', '/v1/submittals', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY),
          'Content-Type': 'application/json',
        }).jsonBody(VALID_BODY_ENTRUSTABLE);
      })
      .willRespondWith(201, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          submittal: {
            id: uuid(),
            tenant_id: uuid(TENANT_ID),
            talent_id: uuid(TALENT_ID),
            job_id: uuid(JOB_ID),
            evidence_package_id: uuid(),
            pinned_examination_id: uuid(EXAM_ID_ENTRUSTABLE),
            state: regex('created|handoff_draft', 'created'),
            created_by: uuid(),
            justification: null,
            failed_criterion_acknowledgments: null,
            created_at: regex(
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
              '2026-05-23T12:00:00Z',
            ),
            confirmed_at: null,
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': IDEMPOTENCY_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(VALID_BODY_ENTRUSTABLE),
        });
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.submittal.state).toBe('created');
        expect(body.submittal.confirmed_at).toBeNull();
      });
  });

  it('rejects submittal returns 422 SUBMITTAL_STRETCH_BLOCKED when tier is STRETCH', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated and there is a STRETCH examination for the talent and job')
      .uponReceiving('a create-submittal request for a STRETCH examination')
      .withRequest('POST', '/v1/submittals', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY),
          'Content-Type': 'application/json',
        }).jsonBody(VALID_BODY_STRETCH);
      })
      .willRespondWith(422, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          error: {
            code: regex('SUBMITTAL_STRETCH_BLOCKED', 'SUBMITTAL_STRETCH_BLOCKED'),
            message: like('Stretch-tier examinations cannot be submitted'),
            request_id: uuid(REQUEST_ID),
            details: like({ examination_id: EXAM_ID_STRETCH, tier: 'STRETCH' }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': IDEMPOTENCY_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(VALID_BODY_STRETCH),
        });
        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body.error.code).toBe('SUBMITTAL_STRETCH_BLOCKED');
      });
  });

  // M5 PR-9 §4.1 — idempotency replay + conflict pact coverage per
  // Plan v1.5 §M5 Track B item 2. Replay: same key + same body returns
  // prior 201 + cached body. Conflict: same key + different body returns
  // 409 IDEMPOTENCY_KEY_CONFLICT.
  const REPLAY_KEY = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f02';
  const CONFLICT_KEY = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f03';

  it('idempotency replay: same key + same body returns cached 201 response', async () => {
    await provider
      .addInteraction()
      .given('an idempotency key has been recorded with a prior create-submittal response')
      .uponReceiving('a create-submittal request replaying a prior key + body')
      .withRequest('POST', '/v1/submittals', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(REPLAY_KEY),
          'Content-Type': 'application/json',
        }).jsonBody(VALID_BODY_ENTRUSTABLE);
      })
      .willRespondWith(201, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          submittal: like({ id: SUBMITTAL_ID_REPLAY, state: 'created' }),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/submittals`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': REPLAY_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(VALID_BODY_ENTRUSTABLE),
        });
        expect(res.status).toBe(201);
      });
  });

  it('idempotency conflict: same key + different body returns 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
    await provider
      .addInteraction()
      .given('an idempotency key has been recorded with a different create-submittal body')
      .uponReceiving('a create-submittal request with a conflicting prior key')
      .withRequest('POST', '/v1/submittals', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(CONFLICT_KEY),
          'Content-Type': 'application/json',
        }).jsonBody(VALID_BODY_ENTRUSTABLE);
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
        const res = await fetch(`${mock.url}/v1/submittals`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': CONFLICT_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(VALID_BODY_ENTRUSTABLE),
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      });
  });
});
