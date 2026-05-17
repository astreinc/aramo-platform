import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { like, uuid } = MatchersV3;

// PR-14 §4.2 — Prohibited-source-type Pact consumer.
//
// Consumer:  prohibited-source-type   (R7 Layer-1 closed-enum tripwire)
// Provider:  aramo-core                (apps/api per Architecture v2.2)
//
// What this test asserts:
//   The closed @IsIn(INGESTION_SOURCES) enum on
//   IngestionPayloadRequestDto.source rejects values outside the
//   allowlisted set ({talent_direct, indeed, github, astre_import})
//   at the wire, returning HTTP 400 VALIDATION_ERROR via the
//   class-validator → AramoExceptionFilter path. This exercises
//   R7 Layer 1 (the structural closed-enum refusal) end-to-end via
//   a consumer contract.
//
// Source value choice (PR-14 §4.2 hard constraint): the test uses a
// generic prohibited source value ('myspace') to exercise the rejection
// path. PR-14 §8.1-B pass established that the closed enum rejects ANY
// non-allowlisted source value identically — the rejection path is the
// same whether the value is 'myspace', 'not_a_real_source', or any other
// non-allowlisted token. Using a generic value keeps this consumer
// contract token-free in directory name, file name, and content.
//
// pact/consumers/ is not in the R7 sealed allowlist (ADR-0011 §Decision
// keeps the allowlist as narrow as possible); the directive §4.2 makes
// "no R7-allowlisted token in this consumer's content" a hard constraint.

const provider = new PactV4({
  consumer: 'prohibited-source-type',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const ACCESS_COOKIE = 'aramo_access_token=eyJfake.access.token';
const PROHIBITED_SOURCE = 'myspace';
const SAMPLE_SHA256 = 'a'.repeat(64);
const SAMPLE_REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1aa0';

describe('prohibited-source-type → POST /v1/ingestion/payloads (closed-enum rejection)', () => {
  it(
    `rejects a payload with a prohibited source value ('${PROHIBITED_SOURCE}') with 400 VALIDATION_ERROR`,
    async () => {
      await provider
        .addInteraction()
        .given('a recruiter session and a prohibited source value at the wire')
        .uponReceiving(
          'an ingestion payload submittal with a source value outside the closed allowlist',
        )
        .withRequest('POST', '/v1/ingestion/payloads', (b) => {
          b.headers({
            Cookie: like(ACCESS_COOKIE),
            'Content-Type': 'application/json',
          }).jsonBody({
            source: PROHIBITED_SOURCE,
            storage_ref: 's3://aramo-raw/example/payload.json',
            sha256: SAMPLE_SHA256,
            content_type: 'application/json',
            captured_at: '2026-05-17T00:00:00Z',
          });
        })
        .willRespondWith(400, (b) => {
          b.jsonBody({
            error: {
              code: 'VALIDATION_ERROR',
              message: like('source must be one of the following values'),
              request_id: uuid(SAMPLE_REQUEST_ID),
              details: like({}),
            },
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
              source: PROHIBITED_SOURCE,
              storage_ref: 's3://aramo-raw/example/payload.json',
              sha256: SAMPLE_SHA256,
              content_type: 'application/json',
              captured_at: '2026-05-17T00:00:00Z',
            }),
          });
          expect(res.status).toBe(400);
          const body = (await res.json()) as { error: { code: string } };
          expect(body.error.code).toBe('VALIDATION_ERROR');
        });
    },
  );
});

beforeAll(() => undefined);
afterAll(() => undefined);
