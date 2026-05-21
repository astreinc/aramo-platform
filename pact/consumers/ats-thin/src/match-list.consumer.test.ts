import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, regex, eachLike, integer, boolean } = MatchersV3;

// M3 PR-8 §4.5 Pact consumer test — GET /v1/jobs/{job_id}/matches.
//
// Asserts the strict Summary contract via Pact `jsonBody` with an
// enumerated list of exactly the TalentJobExaminationSummary fields and
// NO `like(...)` wrapper around the outer data[i] object (directive §4.5
// + Ruling 3 part A). The Full-specific absence is asserted separately by
// the AppModule-end-to-end integration test at
// libs/examination/src/tests/match-list.negative-shape.spec.ts (Ruling 3
// part B / F23).
//
// Consumer: ats-thin (recruiter-facing ATS thin client).
// Provider: aramo-core (apps/api, per PR-8 §4.7 provider verifier
// extension).

const provider = new PactV4({
  consumer: 'ats-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const JOB_ID = '22222222-2222-7222-8222-222222222222';
const JOB_ID_EMPTY = '99999999-9999-7999-8999-999999999999';
const TALENT_ID_1 = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a00';

describe('ATS thin consumer → GET /v1/jobs/{job_id}/matches', () => {
  it('returns 200 with a ranked Summary[] envelope (locked Summary-only contract)', async () => {
    await provider
      .addInteraction()
      .given('a recruiter token, an active requisition with id REQ, and three ranked Summary examinations')
      .uponReceiving('a list-matches request')
      .withRequest('GET', `/v1/jobs/${JOB_ID}/matches`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'X-Request-ID': uuid(REQUEST_ID),
        });
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          // Strict listing — exactly the TalentJobExaminationSummary fields
          // (no like() wrapper around the outer data[i] object).
          data: eachLike({
            examination_id: uuid(),
            talent_id: uuid(TALENT_ID_1),
            job_id: uuid(JOB_ID),
            tier: regex('ENTRUSTABLE|WORTH_CONSIDERING|STRETCH', 'WORTH_CONSIDERING'),
            rank_ordinal: integer(1),
            why_matched_sentence: like('matched on skills X and Y'),
            top_skills: eachLike('TypeScript'),
            confidence_summary: like({
              evidence_strength: like({ level: 'medium', basis: 'evidence_count' }),
              data_completeness: like({ level: 'high', basis: 'fields_present' }),
              constraint_confidence: like({ level: 'medium', basis: 'rate_overlap' }),
            }),
            freshness_indicator: like({ profile_age_days: 14 }),
            computed_at: regex(
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
              '2026-05-01T12:00:00Z',
            ),
          }),
          pagination: {
            cursor: null,
            next_cursor: null,
            page_size: integer(3),
            has_more: boolean(false),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/jobs/${JOB_ID}/matches`, {
          method: 'GET',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'X-Request-ID': REQUEST_ID,
          },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          data: Array<{ examination_id: string; tier: string }>;
          pagination: { page_size: number; has_more: boolean };
        };
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data.length).toBeGreaterThan(0);
        expect(body.pagination).toBeDefined();
      });
  });

  it('returns 200 with an empty data[] when no active requisition exists for the job (not 404)', async () => {
    await provider
      .addInteraction()
      .given('a recruiter token and no active requisition for the job')
      .uponReceiving('a list-matches request against an inactive/unknown job')
      .withRequest('GET', `/v1/jobs/${JOB_ID_EMPTY}/matches`, (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
        });
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
        const res = await fetch(`${mock.url}/v1/jobs/${JOB_ID_EMPTY}/matches`, {
          method: 'GET',
          headers: { Authorization: 'Bearer eyJfake.token' },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          data: unknown[];
          pagination: { has_more: boolean };
        };
        expect(body.data).toEqual([]);
        expect(body.pagination.has_more).toBe(false);
      });
  });

  it('returns 400 INVALID_REQUEST when job_id is not a UUID', async () => {
    await provider
      .addInteraction()
      .given('a recruiter token')
      .uponReceiving('a list-matches request with a malformed job_id')
      .withRequest('GET', '/v1/jobs/not-a-uuid/matches', (b) => {
        b.headers({ Authorization: like('Bearer eyJfake.token') });
      })
      .willRespondWith(400, (b) => {
        b.jsonBody({
          error: {
            code: 'INVALID_REQUEST',
            message: like('job_id must be a UUID'),
            request_id: uuid(),
            details: { invalid_field: 'job_id' },
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/jobs/not-a-uuid/matches`, {
          method: 'GET',
          headers: { Authorization: 'Bearer eyJfake.token' },
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('INVALID_REQUEST');
      });
  });

  it('returns 403 INSUFFICIENT_PERMISSIONS when consumer_type is not "recruiter"', async () => {
    await provider
      .addInteraction()
      .given('a portal-consumer token (not recruiter)')
      .uponReceiving('a list-matches request from a non-recruiter consumer')
      .withRequest('GET', `/v1/jobs/${JOB_ID}/matches`, (b) => {
        b.headers({ Authorization: like('Bearer eyJfake.portal.token') });
      })
      .willRespondWith(403, (b) => {
        b.jsonBody({
          error: {
            code: 'INSUFFICIENT_PERMISSIONS',
            message: like('match-list endpoint is recruiter-only'),
            request_id: uuid(),
            details: like({ consumer_type: 'portal' }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/jobs/${JOB_ID}/matches`, {
          method: 'GET',
          headers: { Authorization: 'Bearer eyJfake.portal.token' },
        });
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      });
  });
});
