import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  TALENT_ID,
  errorBody,
  like,
  makeAtsWebProvider,
  uuid,
} from './support/ats-web-pact.js';

// PC-3 — Pact consumer for ats-web, examination domain.
//
// Consumer: ats-web · Provider: aramo-core (apps/api). Merges into the same
// ats-web-aramo-core.json as engagement + submittal (portal-thin precedent;
// fileParallelism:false + singleFork:true in vitest.config).
//
// Scope (PC-3 Directive §2 + Gate-5 ruling): the ONLY examination endpoint
// ats-web calls — GET /v1/jobs/:job_id/matches (submittals-api.ts:127
// findMatchesForRequisition). 3 interactions:
//   - happy, with-results (1-row ranked list);
//   - happy, empty-list (no active requisition → 200 {data:[], ...}, NOT
//     404 — the deliberate resume-or-create semantics SubmittalWizard uses);
//   - refusal INVALID_REQUEST 400, malformed job_id (FE-supplied path
//     segment).
//
// illegal-state: 0-by-substrate (examination has NO HTTP state-transition
// surface — examine mints, override appends, lifecycle has no HTTP verb;
// the contracted endpoint is a GET).
// idempotency: 0-by-substrate (GET; no Idempotency-Key).
//
// EXCLUDED (R2, no ats-web call site): POST /v1/examinations (examine, mint),
// POST /v1/examinations/:id/overrides.

const provider = makeAtsWebProvider();

const JOB_ID = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const EXAM_ID = '00000000-0000-7000-8000-5e0000000001';
const EMPTY_JOB_ID = 'dddddddd-dddd-7ddd-8ddd-ddddddddeeee';
const BAD_JOB_ID = 'not-a-uuid';

// ======================================================================
// GET /v1/jobs/:job_id/matches — happy (with results)
// ======================================================================
describe('ats-web → GET /v1/jobs/:job_id/matches', () => {
  it('returns 200 with a ranked match summary list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an active requisition with a ranked examination exist')
      .uponReceiving('a match-list read for the requisition (with results)')
      .withRequest('GET', `/v1/jobs/${JOB_ID}/matches`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          data: [
            {
              examination_id: uuid(EXAM_ID),
              talent_id: uuid(TALENT_ID),
              job_id: uuid(JOB_ID),
              tier: 'ENTRUSTABLE',
              rank_ordinal: like(1),
            },
          ],
          pagination: {
            cursor: null,
            next_cursor: null,
            page_size: like(1),
            has_more: false,
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/jobs/${JOB_ID}/matches`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          data: Array<{ examination_id: string; tier: string }>;
          pagination: { has_more: boolean };
        };
        expect(body.data.length).toBeGreaterThan(0);
        expect(body.pagination.has_more).toBe(false);
      });
  });

  // --------------------------------------------------------------------
  // Empty-list happy variant — no active requisition for the job → 200
  // with an empty data array (NOT 404). SubmittalWizard's resume-or-create
  // path depends on this distinction.
  // --------------------------------------------------------------------
  it('returns 200 with an empty list when no active requisition exists', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and no seeded matches exist')
      .uponReceiving('a match-list read for a job with no active requisition')
      .withRequest('GET', `/v1/jobs/${EMPTY_JOB_ID}/matches`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          data: [],
          pagination: {
            cursor: null,
            next_cursor: null,
            page_size: 0,
            has_more: false,
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/jobs/${EMPTY_JOB_ID}/matches`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          data: unknown[];
          pagination: { page_size: number; has_more: boolean };
        };
        expect(body.data).toHaveLength(0);
        expect(body.pagination.page_size).toBe(0);
        expect(body.pagination.has_more).toBe(false);
      });
  });

  // --------------------------------------------------------------------
  // Refusal — malformed job_id path segment → 400 INVALID_REQUEST
  // (validated before any repository read).
  // --------------------------------------------------------------------
  it('returns 400 INVALID_REQUEST for a malformed job_id', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and no seeded matches exist')
      .uponReceiving('a match-list read with a non-UUID job_id')
      .withRequest('GET', `/v1/jobs/${BAD_JOB_ID}/matches`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(400, (b) => {
        b.jsonBody(errorBody('INVALID_REQUEST', 'job_id must be a UUID'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/jobs/${BAD_JOB_ID}/matches`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('INVALID_REQUEST');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
