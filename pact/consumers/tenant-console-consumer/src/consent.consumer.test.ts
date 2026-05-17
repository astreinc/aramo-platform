import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { like, uuid, regex } = MatchersV3;

// PR-9 — Pact consumer for the Aramo Tenant Console (recruiter-facing
// frontend).
//
// Consumer:  tenant-console-consumer  (browser/SPA)
// Provider:  aramo-core                (apps/api per Architecture v2.2;
//            matches the ats-thin convention for apps/api endpoints)
//
// Scope (PR-9 §4.5): the 3 consent read endpoints the tenant-console
// actually consumes:
//
//   1. GET /v1/consent/state/{talent_id}        200 nominal
//   2. GET /v1/consent/state/{talent_id}        401 INVALID_TOKEN (no cookie)
//   3. GET /v1/consent/history/{talent_id}      200 nominal (first page)
//   4. GET /v1/consent/history/{talent_id}      200 paginated (with cursor)
//   5. GET /v1/consent/decision-log/{talent_id} 200 nominal (first page)
//
// Pact coverage is minimum-viable per the directive — only the 3 reads
// PR-9 consumes; PR-9 does not call /consent/grant, /consent/revoke,
// or /consent/check, so those are not in this consumer's contract.
//
// Provider verification of the nominal 200 interactions follows the
// ats-thin precedent: the consumer pact captures the contract; runtime
// access-cookie issuance + state setup against apps/api is required to
// verify and is a deferred provider-side concern (same posture as
// auth-service-consumer's deferred 200 nominal cases per Reading A).
//
// Faithful-display discipline (PR-9 §7, R10): every response shape in
// this file is restricted to the fields openapi/common.yaml defines for
// the corresponding response schema (TalentConsentStateResponse,
// ConsentHistoryResponse, ConsentDecisionLogResponse). The R10-forbidden
// vocabulary listed in scripts/verify-vocabulary.sh does not appear in
// those schemas, and none of those terms are referenced here.

const provider = new PactV4({
  consumer: 'tenant-console-consumer',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const EVENT_ID_A = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a00';
const EVENT_ID_B = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a01';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1aa0';
// PR-15 §4.1 — base64url of {"c":"2026-04-15T12:00:00.000Z","e":"00000000-0000-7000-8000-000000000a01"};
// matches libs/consent/src/lib/util/history-cursor.ts encodeCursor's {c, e}
// shape (created_at + event_id). Replaces a stale {v, cs}-shaped placeholder
// (the original cursor never decoded against the production contract).
const SAMPLE_CURSOR =
  'eyJjIjoiMjAyNi0wNC0xNVQxMjowMDowMC4wMDBaIiwiZSI6IjAwMDAwMDAwLTAwMDAtNzAwMC04MDAwLTAwMDAwMDAwMGEwMSJ9';
const ACCESS_COOKIE = 'aramo_access_token=eyJfake.access.token';

// PR-15 Amendment v1.1 §2.1 (Class A) — millisecond-aware, end-anchored
// pattern matching PR-14's ingestion pact. Pact-rust regex matchers reject
// the API's `.NNNZ` Date.toISOString() output against the previous
// start-anchored, ms-less pattern.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

// ----------------------------------------------------------------------
// Interaction 1 — GET /v1/consent/state/{talent_id} — 200 nominal
// ----------------------------------------------------------------------

describe('tenant-console-consumer → GET /v1/consent/state/:talent_id', () => {
  it('returns 200 with TalentConsentStateResponse (5 scopes)', async () => {
    await provider
      .addInteraction()
      .given('a recruiter session and a talent with consent state')
      .uponReceiving('a consent state read for the talent')
      .withRequest('GET', `/v1/consent/state/${TALENT_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          talent_id: uuid(TALENT_ID),
          tenant_id: uuid(TENANT_ID),
          is_anonymized: false,
          computed_at: regex(ISO_TIMESTAMP, '2026-05-16T00:00:00Z'),
          scopes: [
            {
              scope: 'profile_storage',
              status: 'granted',
              granted_at: regex(ISO_TIMESTAMP, '2026-04-29T00:00:00Z'),
              revoked_at: null,
              expires_at: null,
            },
            {
              scope: 'resume_processing',
              status: 'granted',
              granted_at: regex(ISO_TIMESTAMP, '2026-04-29T00:00:00Z'),
              revoked_at: null,
              expires_at: null,
            },
            {
              scope: 'matching',
              status: 'no_grant',
              granted_at: null,
              revoked_at: null,
              expires_at: null,
            },
            {
              scope: 'contacting',
              status: 'no_grant',
              granted_at: null,
              revoked_at: null,
              expires_at: null,
            },
            {
              scope: 'cross_tenant_visibility',
              status: 'no_grant',
              granted_at: null,
              revoked_at: null,
              expires_at: null,
            },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/state/${TALENT_ID}`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          talent_id: string;
          tenant_id: string;
          is_anonymized: boolean;
          computed_at: string;
          scopes: Array<{ scope: string; status: string }>;
        };
        expect(body.is_anonymized).toBe(false);
        expect(body.scopes).toHaveLength(5);
      });
  });

  // --------------------------------------------------------------------
  // Interaction 2 — GET /v1/consent/state/{talent_id} — 401 AUTH_REQUIRED
  // (no access cookie + no Bearer header). PR-15 Amendment v1.1 §2.3
  // (Class C): the API's JwtAuthGuard throws AUTH_REQUIRED when both
  // Authorization and the aramo_access_token cookie are absent
  // (libs/auth/src/lib/jwt-auth.guard.ts:142-148; guard tests at
  // libs/auth/src/tests/jwt-auth.guard.spec.ts:108). The prior PR-9
  // INVALID_TOKEN assertion was wrong; corrected here.
  // --------------------------------------------------------------------

  it('returns 401 AUTH_REQUIRED when aramo_access_token cookie is missing', async () => {
    await provider
      .addInteraction()
      .given('no setup required')
      .uponReceiving('a consent state read with no access cookie')
      .withRequest('GET', `/v1/consent/state/${TALENT_ID}`)
      .willRespondWith(401, (b) => {
        b.jsonBody({
          error: {
            code: 'AUTH_REQUIRED',
            message: like('Authorization required'),
            request_id: uuid(),
            details: like({}),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/state/${TALENT_ID}`);
        expect(res.status).toBe(401);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('AUTH_REQUIRED');
      });
  });
});

// ----------------------------------------------------------------------
// Interaction 3 — GET /v1/consent/history/{talent_id} — 200 first page
// ----------------------------------------------------------------------

describe('tenant-console-consumer → GET /v1/consent/history/:talent_id', () => {
  it('returns 200 ConsentHistoryResponse first page', async () => {
    await provider
      .addInteraction()
      .given('a recruiter session and a talent with consent history')
      .uponReceiving('a consent history read for the talent (first page)')
      .withRequest('GET', `/v1/consent/history/${TALENT_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          events: [
            {
              event_id: uuid(EVENT_ID_A),
              scope: 'profile_storage',
              action: 'granted',
              created_at: regex(ISO_TIMESTAMP, '2026-04-29T00:00:00Z'),
              expires_at: null,
            },
          ],
          // PR-15 Amendment v1.1 §2.2 (Class B) — with a 1-event seed
          // under the default page limit, the API correctly returns
          // next_cursor: null (no second page). The previous like(...)
          // type-matcher asserted a contract the API never honored.
          next_cursor: null,
          is_anonymized: false,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/consent/history/${TALENT_ID}`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          events: Array<{ event_id: string }>;
          next_cursor: string | null;
          is_anonymized: boolean;
        };
        expect(body.is_anonymized).toBe(false);
        expect(body.events.length).toBeGreaterThan(0);
      });
  });

  // --------------------------------------------------------------------
  // Interaction 4 — GET /v1/consent/history/{talent_id}?cursor=... — 200
  // (paginated; final page → next_cursor is null)
  // --------------------------------------------------------------------

  it('returns 200 ConsentHistoryResponse paginated page (null next_cursor)', async () => {
    await provider
      .addInteraction()
      .given('a recruiter session and a talent with consent history (page 2 final)')
      .uponReceiving('a consent history read with a follow-on cursor')
      .withRequest('GET', `/v1/consent/history/${TALENT_ID}`, (b) => {
        b.query({ cursor: SAMPLE_CURSOR }).headers({
          Cookie: like(ACCESS_COOKIE),
        });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          events: [
            {
              event_id: uuid(EVENT_ID_B),
              scope: 'profile_storage',
              action: 'revoked',
              created_at: regex(ISO_TIMESTAMP, '2026-04-30T00:00:00Z'),
              expires_at: null,
            },
          ],
          next_cursor: null,
          is_anonymized: false,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/consent/history/${TALENT_ID}?cursor=${encodeURIComponent(SAMPLE_CURSOR)}`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          events: unknown[];
          next_cursor: string | null;
        };
        expect(body.next_cursor).toBeNull();
        expect(body.events.length).toBeGreaterThan(0);
      });
  });
});

// ----------------------------------------------------------------------
// Interaction 5 — GET /v1/consent/decision-log/{talent_id} — 200 first page
// ----------------------------------------------------------------------

describe('tenant-console-consumer → GET /v1/consent/decision-log/:talent_id', () => {
  it('returns 200 ConsentDecisionLogResponse first page', async () => {
    await provider
      .addInteraction()
      .given('a recruiter session and a talent with decision-log entries')
      .uponReceiving('a consent decision-log read for the talent')
      .withRequest('GET', `/v1/consent/decision-log/${TALENT_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          entries: [
            {
              event_id: uuid(EVENT_ID_A),
              talent_id: uuid(TALENT_ID),
              event_type: 'consent.grant.recorded',
              created_at: regex(ISO_TIMESTAMP, '2026-04-29T00:00:00Z'),
              actor_id: uuid(),
              actor_type: 'recruiter',
              event_payload: like({ scope: 'profile_storage' }),
            },
          ],
          next_cursor: null,
          is_anonymized: false,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/consent/decision-log/${TALENT_ID}`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          entries: Array<{ event_type: string }>;
          next_cursor: string | null;
          is_anonymized: boolean;
        };
        expect(body.is_anonymized).toBe(false);
        expect(body.entries.length).toBeGreaterThan(0);
        expect(body.next_cursor).toBeNull();
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
