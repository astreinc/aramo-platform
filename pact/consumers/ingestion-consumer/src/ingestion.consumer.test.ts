import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { like, uuid, regex } = MatchersV3;

// PR-14 §4.6 — Ingestion consumer Pact tests.
//
// Consumer:  ingestion-consumer       (the ingestion adapter caller)
// Provider:  aramo-core                (apps/api per Architecture v2.2)
//
// Scope (PR-14 §4.6): the two ingestion endpoints' request/response
// contract shape:
//
//   1. POST /v1/ingestion/payloads               201 accepted (fresh)
//   2. POST /v1/ingestion/indeed/search-results  201 shortlisted_not_unlocked
//
// Pact coverage is minimum-viable per the directive — request/response
// contract shape only. F7 (PR-14 §4.7) extends the provider verifier
// to bootstrap apps/api against a Postgres testcontainer and verify
// these interactions.
//
// Faithful-display discipline (R10): every response shape in this file
// is restricted to the fields openapi/ingestion.yaml defines for the
// corresponding response schema. The R10-forbidden vocabulary listed
// in scripts/verify-vocabulary.sh does not appear in those schemas.

const provider = new PactV4({
  consumer: 'ingestion-consumer',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const PAYLOAD_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1aa0';
const SAMPLE_SHA256_PAYLOAD = 'b'.repeat(64);
const SAMPLE_SHA256_INDEED = 'c'.repeat(64);
const ACCESS_COOKIE = 'aramo_access_token=eyJfake.access.token';
// Matches both `2026-05-17T00:00:00Z` (no millis) and the
// `Date.toISOString()` shape `2026-05-17T02:50:45.279Z` apps/api emits.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

// ----------------------------------------------------------------------
// Interaction 1 — POST /v1/ingestion/payloads — 201 accepted (fresh)
// ----------------------------------------------------------------------

describe('ingestion-consumer → POST /v1/ingestion/payloads', () => {
  it('returns 201 IngestionPayloadResponse for a fresh accepted payload', async () => {
    await provider
      .addInteraction()
      .given(
        'an ingestion session with no prior payload matching the submitted sha256',
      )
      .uponReceiving('a generic ingestion payload submittal')
      .withRequest('POST', '/v1/ingestion/payloads', (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Content-Type': 'application/json',
        }).jsonBody({
          source: 'talent_direct',
          storage_ref: 's3://aramo-raw/talent-direct/example.json',
          sha256: SAMPLE_SHA256_PAYLOAD,
          content_type: 'application/json',
          captured_at: '2026-05-17T00:00:00Z',
        });
      })
      .willRespondWith(201, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          id: uuid(PAYLOAD_ID),
          tenant_id: uuid(TENANT_ID),
          source: 'talent_direct',
          status: 'accepted',
          dedup: {
            match_signal: null,
            existing_payload_id: null,
          },
          created_at: regex(ISO_TIMESTAMP, '2026-05-17T00:00:01Z'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/ingestion/payloads`, {
          method: 'POST',
          headers: {
            Cookie: ACCESS_COOKIE,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            source: 'talent_direct',
            storage_ref: 's3://aramo-raw/talent-direct/example.json',
            sha256: SAMPLE_SHA256_PAYLOAD,
            content_type: 'application/json',
            captured_at: '2026-05-17T00:00:00Z',
          }),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as {
          id: string;
          tenant_id: string;
          source: string;
          status: string;
        };
        expect(body.status).toBe('accepted');
        expect(body.source).toBe('talent_direct');
      });
  });
});

// ----------------------------------------------------------------------
// Interaction 2 — POST /v1/ingestion/indeed/search-results — 201
// ----------------------------------------------------------------------

describe('ingestion-consumer → POST /v1/ingestion/indeed/search-results', () => {
  it('returns 201 IndeedSearchResultsResponse for a fresh shortlist record', async () => {
    await provider
      .addInteraction()
      .given(
        'an ingestion session and a talent record with no prior indeed shortlist for the submitted sha256',
      )
      .uponReceiving('an indeed search-results shortlist submittal')
      .withRequest('POST', '/v1/ingestion/indeed/search-results', (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Content-Type': 'application/json',
        }).jsonBody({
          talent_id: TALENT_ID,
          storage_ref: 's3://aramo-raw/indeed/shortlist-example.json',
          sha256: SAMPLE_SHA256_INDEED,
          content_type: 'application/json',
          captured_at: '2026-05-17T00:00:00Z',
        });
      })
      .willRespondWith(201, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          id: uuid(PAYLOAD_ID),
          tenant_id: uuid(TENANT_ID),
          source: 'indeed',
          status: 'shortlisted_not_unlocked',
          dedup: {
            match_signal: null,
            existing_payload_id: null,
          },
          created_at: regex(ISO_TIMESTAMP, '2026-05-17T00:00:01Z'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/ingestion/indeed/search-results`,
          {
            method: 'POST',
            headers: {
              Cookie: ACCESS_COOKIE,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              talent_id: TALENT_ID,
              storage_ref: 's3://aramo-raw/indeed/shortlist-example.json',
              sha256: SAMPLE_SHA256_INDEED,
              content_type: 'application/json',
              captured_at: '2026-05-17T00:00:00Z',
            }),
          },
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as {
          id: string;
          source: string;
          status: string;
        };
        expect(body.source).toBe('indeed');
        expect(body.status).toBe('shortlisted_not_unlocked');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
