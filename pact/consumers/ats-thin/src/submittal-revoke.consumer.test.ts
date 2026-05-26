import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, regex } = MatchersV3;

// M4 PR-7 §4.8 + M5 PR-8b2 §4.14 Pact consumer — POST
// /v1/submittals/{submittal_id}/revoke.
//
// Four interactions (directive §4.8 + M5 PR-8b2 Q3 expansion):
//   1) Submittal in state='submitted_to_ats' + valid justification → 200 +
//      RevokeSubmittalResponse (strict shape with state='revoked',
//      revoked_at + revoked_by + revocation_justification populated,
//      and `evidence_package_mutated: false` LOCKED literal).
//   2) Submittal in state='created' → 200 sibling-revoke success
//      (per M5 PR-8b2 Q3: revocable from any non-terminal state;
//      M4 'draft' renames to canonical 'created').
//   3) Submittal in state='revoked' → 422 REVOKE_NOT_ALLOWED with
//      current_state='revoked' in details (terminal-state refusal).
//   4) submittal_id not seeded → 404 NOT_FOUND.
//
// Consumer: ats-thin (recruiter-facing).
// Provider: aramo-core (apps/api). State handlers extend
// pact/provider/src/verify-api.ts seedSubmittalRevokeFixture per §4.9.
// The provider verification additionally asserts the state-isolation
// invariant (TalentJobEvidencePackage row byte-identical pre/post on
// EVERY revoke interaction — success + 3 refusals) — the second Aramo
// Pact contract that enforces a state-isolation invariant (the first
// was M4 PR-5's TalentJobExamination state-isolation on override
// create).
//
// Locked invariants asserted:
//   - 200 response carries the full updated TalentSubmittalRecord
//     (state='revoked', revoked_at + revoked_by + revocation_justification
//     populated) + the literal `evidence_package_mutated: false`.
//   - 422 / 404 refusals carry the AramoError envelope with the named
//     code (REVOKE_NOT_ALLOWED / NOT_FOUND).
//   - X-Request-ID header round-trips through every interaction.

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

// Distinct submittal_ids for each interaction (each state handler seeds
// the named row at the named state).
const SUBMITTAL_ID_SUBMITTED = '99990000-0000-7000-8000-000000000931';
const SUBMITTAL_ID_DRAFT = '99990000-0000-7000-8000-000000000932';
const SUBMITTAL_ID_ALREADY_REVOKED = '99990000-0000-7000-8000-000000000933';
const SUBMITTAL_ID_MISSING = '99990000-0000-7000-8000-0000000009ff';

const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b7100';
const IDEMPOTENCY_KEY_1 = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b7101';
const IDEMPOTENCY_KEY_2 = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b7102';
const IDEMPOTENCY_KEY_3 = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b7103';
const IDEMPOTENCY_KEY_4 = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b7104';

const REVOKE_BODY = {
  revocation_justification: 'Position has been put on hold by the hiring manager; revoking the submittal until the requisition resumes.',
};

describe('ATS thin consumer → POST /v1/submittals/{id}/revoke', () => {
  it('revokes returns 200 with evidence_package_mutated=false when submittal is in submitted state', async () => {
    await provider
      .addInteraction()
      .given(
        'a recruiter has authenticated and a submitted TalentSubmittalRecord exists for the tenant',
      )
      .uponReceiving('a submittal-revoke request against a submitted submittal')
      .withRequest(
        'POST',
        `/v1/submittals/${SUBMITTAL_ID_SUBMITTED}/revoke`,
        (b) => {
          b.headers({
            Authorization: like('Bearer eyJfake.token'),
            'X-Request-ID': uuid(REQUEST_ID),
            'Idempotency-Key': uuid(IDEMPOTENCY_KEY_1),
            'Content-Type': 'application/json',
          }).jsonBody(REVOKE_BODY);
        },
      )
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          submittal: {
            id: uuid(SUBMITTAL_ID_SUBMITTED),
            tenant_id: uuid(TENANT_ID),
            talent_id: uuid(TALENT_ID),
            job_id: uuid(JOB_ID),
            evidence_package_id: uuid(),
            pinned_examination_id: uuid(EXAM_ID),
            state: regex('created|handoff_draft|ready_for_review|submitted_to_ats|confirmed|revoked', 'revoked'),
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
            revoked_at: regex(
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
              '2026-05-23T15:00:00Z',
            ),
            revoked_by: uuid(),
            revocation_justification: like(REVOKE_BODY.revocation_justification),
          },
          evidence_package_mutated: false,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/submittals/${SUBMITTAL_ID_SUBMITTED}/revoke`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer eyJfake.token',
              'X-Request-ID': REQUEST_ID,
              'Idempotency-Key': IDEMPOTENCY_KEY_1,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(REVOKE_BODY),
          },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          submittal: { state: string; revoked_at: string | null };
          evidence_package_mutated: boolean;
        };
        expect(body.submittal.state).toBe('revoked');
        expect(body.submittal.revoked_at).not.toBeNull();
        expect(body.evidence_package_mutated).toBe(false);
      });
  });

  it('revokes returns 200 (sibling-revoke from created) per M5 PR-8b2 Q3 expansion', async () => {
    // M5 PR-8b2 Q3 + Ruling 5: revoke is now legal from any
    // non-terminal state (created, handoff_draft, ready_for_review,
    // submitted_to_ats). M4 'draft' renames to canonical 'created';
    // M4's REVOKE_NOT_ALLOWED-from-draft semantic flips to 200 success.
    await provider
      .addInteraction()
      .given(
        'a recruiter has authenticated and a draft TalentSubmittalRecord exists for the tenant',
      )
      .uponReceiving('a submittal-revoke request against a created submittal (sibling-revoke)')
      .withRequest(
        'POST',
        `/v1/submittals/${SUBMITTAL_ID_DRAFT}/revoke`,
        (b) => {
          b.headers({
            Authorization: like('Bearer eyJfake.token'),
            'X-Request-ID': uuid(REQUEST_ID),
            'Idempotency-Key': uuid(IDEMPOTENCY_KEY_2),
            'Content-Type': 'application/json',
          }).jsonBody(REVOKE_BODY);
        },
      )
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          submittal: {
            id: uuid(SUBMITTAL_ID_DRAFT),
            tenant_id: uuid(TENANT_ID),
            talent_id: uuid(),
            job_id: uuid(),
            evidence_package_id: uuid(),
            pinned_examination_id: uuid(),
            state: regex('created|handoff_draft|ready_for_review|submitted_to_ats|confirmed|revoked', 'revoked'),
            created_by: uuid(),
            justification: null,
            failed_criterion_acknowledgments: null,
            created_at: regex(
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
              '2026-05-22T12:00:00Z',
            ),
            confirmed_at: null,
            revoked_at: regex(
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
              '2026-05-23T15:00:00Z',
            ),
            revoked_by: uuid(),
            revocation_justification: like(REVOKE_BODY.revocation_justification),
          },
          evidence_package_mutated: false,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/submittals/${SUBMITTAL_ID_DRAFT}/revoke`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer eyJfake.token',
              'X-Request-ID': REQUEST_ID,
              'Idempotency-Key': IDEMPOTENCY_KEY_2,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(REVOKE_BODY),
          },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          submittal: { state: string };
          evidence_package_mutated: boolean;
        };
        expect(body.submittal.state).toBe('revoked');
        expect(body.evidence_package_mutated).toBe(false);
      });
  });

  it('rejects revoke returns 422 REVOKE_NOT_ALLOWED when submittal is already revoked', async () => {
    await provider
      .addInteraction()
      .given(
        'a recruiter has authenticated and an already-revoked TalentSubmittalRecord exists for the tenant',
      )
      .uponReceiving(
        'a submittal-revoke request against an already-revoked submittal',
      )
      .withRequest(
        'POST',
        `/v1/submittals/${SUBMITTAL_ID_ALREADY_REVOKED}/revoke`,
        (b) => {
          b.headers({
            Authorization: like('Bearer eyJfake.token'),
            'X-Request-ID': uuid(REQUEST_ID),
            'Idempotency-Key': uuid(IDEMPOTENCY_KEY_3),
            'Content-Type': 'application/json',
          }).jsonBody(REVOKE_BODY);
        },
      )
      .willRespondWith(422, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          error: {
            code: regex('REVOKE_NOT_ALLOWED', 'REVOKE_NOT_ALLOWED'),
            message: like(
              'Submittal in state revoked cannot be revoked; terminal states (confirmed, revoked) are not revocable',
            ),
            request_id: uuid(REQUEST_ID),
            details: like({
              submittal_id: SUBMITTAL_ID_ALREADY_REVOKED,
              current_state: 'revoked',
            }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/submittals/${SUBMITTAL_ID_ALREADY_REVOKED}/revoke`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer eyJfake.token',
              'X-Request-ID': REQUEST_ID,
              'Idempotency-Key': IDEMPOTENCY_KEY_3,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(REVOKE_BODY),
          },
        );
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('REVOKE_NOT_ALLOWED');
      });
  });

  it('rejects revoke returns 404 NOT_FOUND when submittal does not exist', async () => {
    await provider
      .addInteraction()
      .given(
        'a recruiter has authenticated and the submittal-revoke target does not exist for the tenant',
      )
      .uponReceiving(
        'a submittal-revoke request against a non-existent submittal',
      )
      .withRequest(
        'POST',
        `/v1/submittals/${SUBMITTAL_ID_MISSING}/revoke`,
        (b) => {
          b.headers({
            Authorization: like('Bearer eyJfake.token'),
            'X-Request-ID': uuid(REQUEST_ID),
            'Idempotency-Key': uuid(IDEMPOTENCY_KEY_4),
            'Content-Type': 'application/json',
          }).jsonBody(REVOKE_BODY);
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
          `${mock.url}/v1/submittals/${SUBMITTAL_ID_MISSING}/revoke`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer eyJfake.token',
              'X-Request-ID': REQUEST_ID,
              'Idempotency-Key': IDEMPOTENCY_KEY_4,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(REVOKE_BODY),
          },
        );
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('NOT_FOUND');
      });
  });
});

// Suppress unused-constant warnings — these are documentation-only.
void TALENT_ID;
void JOB_ID;
void EXAM_ID;
