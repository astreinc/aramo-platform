import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { like, uuid } = MatchersV3;

// PR-M0R-1 — Pact consumer for the Aramo Auth Service.
//
// Consumer:  auth-service-consumer  (browser/SPA-like client)
// Provider:  aramo-auth-service     (apps/auth-service; mirrors deployable
//            name per Architecture v2.1 §1.1; amended via
//            PR-M0R-1 Directive Amendment v1.0 §2.2)
//
// Covers all 6 endpoints from openapi/auth.yaml. Per directive §4 the
// interaction set covers nominal success + relevant error cases. For PR-M0R-1
// minimum-viable form (Reading A operative per M0 Remediation Plan §1.2),
// interactions are limited to those verifiable without runtime token
// issuance / refresh-token seeding / external Cognito mocking. 6 interactions:
//
//   1. GET /.well-known/jwks.json                                 200 nominal
//   2. GET /auth/unknown/login                                    400 VALIDATION_ERROR
//   3. GET /auth/recruiter/callback (no pkce_state cookie)        400 VALIDATION_ERROR
//   4. POST /auth/recruiter/refresh (no refresh cookie)           401 REFRESH_TOKEN_INVALID
//   5. POST /auth/recruiter/logout (no cookie)                    204 idempotent
//   6. GET /auth/recruiter/session (no access cookie)             401 INVALID_TOKEN
//
// Deferred (Reading A minimum-viable form):
//   - /login 302 nominal: the Pact verifier's HTTP client follows the
//     302 redirect to the Cognito authorize URL during provider
//     verification, which is non-localhost and unreachable in test. A
//     follow-on PR can either disable redirect-following in the verifier
//     config (when @pact-foundation/pact exposes that option) or expose
//     a verifier request filter that returns the 302 directly.
//   - /refresh, /callback (Cognito-exchange path), /session 200 nominal:
//     require refresh-token seeding via libs/auth-storage + access-token
//     issuance via auth-helpers + a verifier request filter to inject
//     freshly-issued cookies per interaction. Out of PR-M0R-1 scope.
//
// Per Reading A, the runnable machinery present here satisfies §6 DoD #3
// (consumer pacts for every endpoint added — coverage includes all 6
// endpoints, just not every status branch per endpoint) and #4 (provider
// verification machinery exists and runs) in minimum-viable form.

const provider = new PactV4({
  consumer: 'auth-service-consumer',
  provider: 'aramo-auth-service',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a00';

// ----------------------------------------------------------------------
// Interaction 1 — GET /.well-known/jwks.json — 200 nominal
// ----------------------------------------------------------------------

describe('auth-service-consumer → GET /.well-known/jwks.json', () => {
  it('returns 200 with JwksResponse (single RSA signing key)', async () => {
    await provider
      .addInteraction()
      .given('AUTH_PRIVATE_KEY is configured')
      .uponReceiving('a JWKS request')
      .withRequest('GET', '/.well-known/jwks.json')
      .willRespondWith(200, (b) => {
        // X-Request-ID asserted (verifier sees RequestIdMiddleware-emitted
        // value); Cache-Control deliberately not asserted here — Pact splits
        // multi-value headers on commas and the regex matching becomes
        // unwieldy for "public, max-age=300". The value is fixed by the
        // jwks.controller and verified by the auth-service unit suite.
        b.headers({
          'X-Request-ID': uuid(REQUEST_ID),
        }).jsonBody({
          keys: [
            {
              kty: 'RSA',
              use: 'sig',
              alg: 'RS256',
              kid: like('sha256-fingerprint-base64url'),
              n: like('rsa-modulus-base64url'),
              e: like('AQAB'),
            },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/.well-known/jwks.json`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          keys: Array<{ kty: string; use: string; alg: string; kid: string }>;
        };
        expect(body.keys).toHaveLength(1);
        expect(body.keys[0]?.kty).toBe('RSA');
        expect(body.keys[0]?.use).toBe('sig');
        expect(body.keys[0]?.alg).toBe('RS256');
      });
  });
});

// ----------------------------------------------------------------------
// Interaction 2 — GET /auth/{consumer}/login — 400 invalid consumer
// (302 nominal is deferred — see file header)
// ----------------------------------------------------------------------

describe('auth-service-consumer → GET /auth/{consumer}/login', () => {
  it('returns 400 VALIDATION_ERROR when consumer path param is not a recognized value', async () => {
    await provider
      .addInteraction()
      .given('no setup required')
      .uponReceiving('a login initiation with an unknown consumer')
      .withRequest('GET', '/auth/unknown/login')
      .willRespondWith(400, (b) => {
        b.jsonBody({
          error: {
            code: 'VALIDATION_ERROR',
            message: like('Unknown consumer'),
            request_id: uuid(),
            details: like({ reason: 'invalid_consumer' }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/auth/unknown/login`, {
          redirect: 'manual',
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as {
          error: { code: string; details: { reason: string } };
        };
        expect(body.error.code).toBe('VALIDATION_ERROR');
        expect(body.error.details.reason).toBe('invalid_consumer');
      });
  });
});

// ----------------------------------------------------------------------
// Interaction 3 — GET /auth/{consumer}/callback — 400 VALIDATION_ERROR
// (missing pkce_state cookie; avoids Cognito mock dependency)
// ----------------------------------------------------------------------

describe('auth-service-consumer → GET /auth/{consumer}/callback', () => {
  it('returns 400 VALIDATION_ERROR when aramo_pkce_state cookie is missing', async () => {
    await provider
      .addInteraction()
      .given('no setup required')
      .uponReceiving('a callback with code and state but no pkce_state cookie')
      .withRequest('GET', '/auth/recruiter/callback', (b) => {
        b.query({ code: 'cognito-auth-code', state: 'state-value' });
      })
      .willRespondWith(400, (b) => {
        b.jsonBody({
          error: {
            code: 'VALIDATION_ERROR',
            message: like('Callback validation failed'),
            request_id: uuid(),
            details: like({ reason: 'pkce_state_missing' }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/auth/recruiter/callback?code=cognito-auth-code&state=state-value`,
          { redirect: 'manual' },
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('VALIDATION_ERROR');
      });
  });
});

// ----------------------------------------------------------------------
// Interaction 4 — POST /auth/{consumer}/refresh — 401 REFRESH_TOKEN_INVALID
// ----------------------------------------------------------------------

describe('auth-service-consumer → POST /auth/{consumer}/refresh', () => {
  it('returns 401 REFRESH_TOKEN_INVALID when no aramo_refresh_token cookie is sent', async () => {
    await provider
      .addInteraction()
      .given('no setup required')
      .uponReceiving('a refresh request with no refresh cookie')
      .withRequest('POST', '/auth/recruiter/refresh')
      .willRespondWith(401, (b) => {
        b.jsonBody({
          error: {
            code: 'REFRESH_TOKEN_INVALID',
            message: like('Refresh token invalid'),
            request_id: uuid(),
            details: like({ reason: 'refresh_cookie_missing' }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/auth/recruiter/refresh`, {
          method: 'POST',
        });
        expect(res.status).toBe(401);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('REFRESH_TOKEN_INVALID');
      });
  });
});

// ----------------------------------------------------------------------
// Interaction 5 — POST /auth/{consumer}/logout — 204 idempotent
// ----------------------------------------------------------------------

describe('auth-service-consumer → POST /auth/{consumer}/logout', () => {
  it('returns 204 when no cookie present (idempotent lenient-clear per openapi LO.2.s)', async () => {
    await provider
      .addInteraction()
      .given('no setup required')
      .uponReceiving('a logout request with no refresh cookie')
      .withRequest('POST', '/auth/recruiter/logout')
      .willRespondWith(204)
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/auth/recruiter/logout`, {
          method: 'POST',
        });
        expect(res.status).toBe(204);
      });
  });
});

// ----------------------------------------------------------------------
// Interaction 6 — GET /auth/{consumer}/session — 401 INVALID_TOKEN
// ----------------------------------------------------------------------

describe('auth-service-consumer → GET /auth/{consumer}/session', () => {
  it('returns 401 INVALID_TOKEN when aramo_access_token cookie is missing', async () => {
    await provider
      .addInteraction()
      .given('no setup required')
      .uponReceiving('a session introspection with no access cookie')
      .withRequest('GET', '/auth/recruiter/session')
      .willRespondWith(401, (b) => {
        b.jsonBody({
          error: {
            code: 'INVALID_TOKEN',
            message: like('Access cookie missing'),
            request_id: uuid(),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/auth/recruiter/session`);
        expect(res.status).toBe(401);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('INVALID_TOKEN');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
