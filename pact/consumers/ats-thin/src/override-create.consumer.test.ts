import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, regex } = MatchersV3;

// M4 PR-5 §4.9 Pact consumer — POST /v1/examinations/{id}/overrides.
//
// Three interactions:
//   1) Active examination + valid override_type='tier' → 201 +
//      CreateOverrideResponse (strict shape with examination_mutated=false
//      and full override fields).
//   2) Invalid override_type (not in closed list) → 422 OVERRIDE_INVALID.
//   3) Non-existent examination_id → 404 NOT_FOUND.
//
// Consumer: ats-thin (recruiter-facing).
// Provider: aramo-core (apps/api). State handlers extend
// pact/provider/src/verify-api.ts seedOverrideFixture per §4.10. The
// provider verification additionally asserts the state-isolation
// invariant (TalentJobExamination row byte-identical pre/post on every
// successful override interaction) — the first Aramo Pact contract that
// enforces a state-isolation invariant.
//
// Locked invariants asserted:
//   - 201 response carries the full ExaminationOverride entity + the
//     literal `examination_mutated: false` (LOCKED const per directive).
//   - 422 / 404 refusals carry the AramoError envelope with the named
//     code (OVERRIDE_INVALID / NOT_FOUND).
//   - X-Request-ID header round-tripped through every interaction.

const provider = new PactV4({
  consumer: 'ats-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const JOB_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
// Active examination seeded by the provider state handler for the
// override-create happy + invalid-type interactions.
const EXAM_ID_ACTIVE = '55550000-0000-7000-8000-0000000f0001';
// UUID-shaped but NOT seeded by the provider — used for the NOT_FOUND
// interaction.
const EXAM_ID_MISSING = '66660000-0000-7000-8000-0000000f0099';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1500';
const IDEMPOTENCY_KEY_1 = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1501';
const IDEMPOTENCY_KEY_2 = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1502';
const IDEMPOTENCY_KEY_3 = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1503';

const VALID_TIER_BODY = {
  override_type: 'tier',
  target_field: 'tier',
  justification:
    'Recruiter judgment: talent work history supports a higher entrustment than the system-assigned tier.',
};

const INVALID_TYPE_BODY = {
  override_type: 'invalid_type',
  target_field: 'tier',
  justification: 'Should be rejected by the closed-list enum check.',
};

const MISSING_EXAM_BODY = {
  ...VALID_TIER_BODY,
  justification: 'Targets a non-existent examination_id; should return NOT_FOUND.',
};

describe('ATS thin consumer → POST /v1/examinations/{id}/overrides', () => {
  it('creates override returns 201 with examination_mutated=false when override_type is tier and examination is active', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated and an active examination exists')
      .uponReceiving('an override-create request with override_type=tier')
      .withRequest('POST', `/v1/examinations/${EXAM_ID_ACTIVE}/overrides`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY_1),
          'Content-Type': 'application/json',
        }).jsonBody(VALID_TIER_BODY);
      })
      .willRespondWith(201, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          override: {
            id: uuid(),
            tenant_id: uuid(TENANT_ID),
            examination_id: uuid(EXAM_ID_ACTIVE),
            override_type: regex('tier|risk_flag|gap|constraint_check', 'tier'),
            target_field: like('tier'),
            justification: like(VALID_TIER_BODY.justification),
            created_by: uuid(),
            created_at: regex(
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
              '2026-05-23T12:00:00Z',
            ),
          },
          examination_mutated: false,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/examinations/${EXAM_ID_ACTIVE}/overrides`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer eyJfake.token',
              'X-Request-ID': REQUEST_ID,
              'Idempotency-Key': IDEMPOTENCY_KEY_1,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(VALID_TIER_BODY),
          },
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as {
          override: { override_type: string; examination_id: string };
          examination_mutated: boolean;
        };
        expect(body.examination_mutated).toBe(false);
        expect(body.override.override_type).toBe('tier');
        expect(body.override.examination_id).toBe(EXAM_ID_ACTIVE);
      });
  });

  it('rejects override returns 422 OVERRIDE_INVALID when override_type is not in closed list', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated and an active examination exists')
      .uponReceiving('an override-create request with an unknown override_type')
      .withRequest('POST', `/v1/examinations/${EXAM_ID_ACTIVE}/overrides`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY_2),
          'Content-Type': 'application/json',
        }).jsonBody(INVALID_TYPE_BODY);
      })
      .willRespondWith(422, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          error: {
            code: regex('OVERRIDE_INVALID', 'OVERRIDE_INVALID'),
            message: like('override_type is not in the closed list'),
            request_id: uuid(REQUEST_ID),
            details: like({ invalid_field: 'override_type' }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/examinations/${EXAM_ID_ACTIVE}/overrides`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer eyJfake.token',
              'X-Request-ID': REQUEST_ID,
              'Idempotency-Key': IDEMPOTENCY_KEY_2,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(INVALID_TYPE_BODY),
          },
        );
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('OVERRIDE_INVALID');
      });
  });

  it('rejects override returns 404 NOT_FOUND when examination does not exist', async () => {
    await provider
      .addInteraction()
      .given('a recruiter has authenticated')
      .uponReceiving('an override-create request targeting a non-existent examination')
      .withRequest('POST', `/v1/examinations/${EXAM_ID_MISSING}/overrides`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(IDEMPOTENCY_KEY_3),
          'Content-Type': 'application/json',
        }).jsonBody(MISSING_EXAM_BODY);
      })
      .willRespondWith(404, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          error: {
            code: regex('NOT_FOUND', 'NOT_FOUND'),
            message: like('TalentJobExamination not found'),
            request_id: uuid(REQUEST_ID),
            details: like({}),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/examinations/${EXAM_ID_MISSING}/overrides`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer eyJfake.token',
              'X-Request-ID': REQUEST_ID,
              'Idempotency-Key': IDEMPOTENCY_KEY_3,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(MISSING_EXAM_BODY),
          },
        );
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('NOT_FOUND');
      });
  });

  // M5 PR-9 §4.1 — idempotency replay + conflict per Plan v1.5 §M5 Track B item 2.
  const REPLAY_KEY = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1510';
  const CONFLICT_KEY = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1511';

  it('idempotency replay: same key + same body returns cached 201 response', async () => {
    await provider
      .addInteraction()
      .given('an idempotency key has been recorded with a prior override-create response')
      .uponReceiving('an override-create request replaying a prior key + body')
      .withRequest('POST', `/v1/examinations/${EXAM_ID_ACTIVE}/overrides`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(REPLAY_KEY),
          'Content-Type': 'application/json',
        }).jsonBody(VALID_TIER_BODY);
      })
      .willRespondWith(201, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          override: like({ examination_id: EXAM_ID_ACTIVE }),
          examination_mutated: false,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/examinations/${EXAM_ID_ACTIVE}/overrides`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': REPLAY_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(VALID_TIER_BODY),
        });
        expect(res.status).toBe(201);
      });
  });

  it('idempotency conflict: same key + different body returns 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
    await provider
      .addInteraction()
      .given('an idempotency key has been recorded with a different override-create body')
      .uponReceiving('an override-create request with a conflicting prior key')
      .withRequest('POST', `/v1/examinations/${EXAM_ID_ACTIVE}/overrides`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
          'Idempotency-Key': uuid(CONFLICT_KEY),
          'Content-Type': 'application/json',
        }).jsonBody(VALID_TIER_BODY);
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
        const res = await fetch(`${mock.url}/v1/examinations/${EXAM_ID_ACTIVE}/overrides`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
            'Idempotency-Key': CONFLICT_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(VALID_TIER_BODY),
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      });
  });
});

// Suppress unused-constant warnings — these are documentation-only.
void TALENT_ID;
void JOB_ID;
