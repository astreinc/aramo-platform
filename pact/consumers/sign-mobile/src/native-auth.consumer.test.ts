import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, integer, boolean, datetime, eachLike, regex } = MatchersV3;

// AUTH-SIGNIN-1 Amendment M-A1 §5 — Pact consumer for the native authentication
// endpoints, as the Aramo Sign mobile app calls them.
//
// Consumer:  sign-mobile         (mobile/sign — the native app)
// Provider:  aramo-auth-service  (apps/auth-service)
//
// Counted SEPARATELY from auth-service-consumer (its own pact file,
// pact/pacts/sign-mobile-aramo-auth-service.json, verified by
// pact/provider/src/verify.ts). Cognito is never contacted: the provider
// harness binds a fake behind NATIVE_CODE_EXCHANGE and seeds device sessions
// through its state handlers. The fixed values below MUST match
// pact/provider/src/support/native-auth-states.ts.
//
// Interactions:
//   1. POST /auth/native/sign/token             200 nominal (token pair, no-store)
//   2. POST /auth/native/sign/token             400 redirect_uri_not_allowed
//   3. POST /auth/native/sign/refresh           200 nominal (rotated pair)
//   4. POST /auth/native/sign/refresh           401 REFRESH_TOKEN_INVALID not_found
//   5. POST /auth/native/sign/logout            204
//   6. GET  /auth/native/sign/sessions          200 (Bearer)
//   7. GET  /auth/native/sign/sessions          401 AUTH_REQUIRED (no Bearer)
//   8. DELETE /auth/native/sign/sessions/{id}   404 (not the caller's session)

const provider = new PactV4({
  consumer: 'sign-mobile',
  provider: 'aramo-auth-service',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const PACT_NATIVE_CODE = 'pact-native-authorization-code';
const PACT_NATIVE_VERIFIER = 'pact-native-code-verifier-0123456789abcdefghijklmnop';
const PACT_NATIVE_NONCE = 'pact-native-nonce-0001';
const PACT_NATIVE_REFRESH = 'pact-native-refresh-token-0001';
// A placeholder the provider's request filter swaps for a freshly minted native
// access token of the seeded device session.
const PACT_NATIVE_BEARER = 'Bearer pact-native-access-token';
const APP_LINK = 'https://sign.aramo.ai/auth/native/callback';
const UNKNOWN_SESSION = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a77';

const DEVICE = { installation_id: 'pact-installation-1', platform: 'ios', app_version: '1.0.0' };

function tokenPairBody() {
  return {
    access_token: like('eyJhbGciOiJSUzI1NiJ9.e30.sig'),
    token_type: 'Bearer',
    expires_in: integer(900),
    refresh_token: like('opaque-refresh-token'),
    device_session_id: uuid('0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a10'),
  };
}

function errorBody(code: string, reason: string) {
  return {
    error: {
      code,
      message: like('message'),
      request_id: uuid(),
      details: like({ reason }),
    },
  };
}

describe('sign-mobile → POST /auth/native/sign/token', () => {
  it('exchanges a native authorization code for a token pair (200, Cache-Control: no-store)', async () => {
    await provider
      .addInteraction()
      .given('a native authorization code is redeemable')
      .uponReceiving('a native code exchange')
      .withRequest('POST', '/auth/native/sign/token', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({
          code: PACT_NATIVE_CODE,
          code_verifier: PACT_NATIVE_VERIFIER,
          redirect_uri: APP_LINK,
          nonce: PACT_NATIVE_NONCE,
          device: DEVICE,
        });
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'Cache-Control': 'no-store' }).jsonBody(tokenPairBody());
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/auth/native/sign/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: PACT_NATIVE_CODE, code_verifier: PACT_NATIVE_VERIFIER, redirect_uri: APP_LINK, nonce: PACT_NATIVE_NONCE, device: DEVICE }),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        const body = (await res.json()) as { token_type: string; expires_in: number };
        expect(body.token_type).toBe('Bearer');
        expect(body.expires_in).toBe(900);
      });
  });

  it('refuses a redirect_uri that is not a registered native callback (400)', async () => {
    const reqBody = { code: 'any-code', code_verifier: PACT_NATIVE_VERIFIER, redirect_uri: 'https://evil.example/cb', nonce: 'n-evil', device: DEVICE };
    await provider
      .addInteraction()
      .given('no setup required')
      .uponReceiving('a native code exchange with an unregistered redirect_uri')
      .withRequest('POST', '/auth/native/sign/token', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody(reqBody);
      })
      .willRespondWith(400, (b) => {
        b.jsonBody(errorBody('VALIDATION_ERROR', 'redirect_uri_not_allowed'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/auth/native/sign/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqBody),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { details: { reason: string } } };
        expect(body.error.details.reason).toBe('redirect_uri_not_allowed');
      });
  });
});

describe('sign-mobile → POST /auth/native/sign/refresh', () => {
  it('rotates the refresh token (200, a new pair for the same device session)', async () => {
    await provider
      .addInteraction()
      .given('a native device session exists')
      .uponReceiving('a native refresh')
      .withRequest('POST', '/auth/native/sign/refresh', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({ refresh_token: PACT_NATIVE_REFRESH });
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'Cache-Control': 'no-store' }).jsonBody(tokenPairBody());
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/auth/native/sign/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: PACT_NATIVE_REFRESH }),
        });
        expect(res.status).toBe(200);
      });
  });

  it('refuses an unknown refresh token (401 REFRESH_TOKEN_INVALID)', async () => {
    await provider
      .addInteraction()
      .given('no setup required')
      .uponReceiving('a native refresh with an unknown token')
      .withRequest('POST', '/auth/native/sign/refresh', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({ refresh_token: 'never-issued-token' });
      })
      .willRespondWith(401, (b) => {
        b.jsonBody(errorBody('REFRESH_TOKEN_INVALID', 'not_found'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/auth/native/sign/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: 'never-issued-token' }),
        });
        expect(res.status).toBe(401);
      });
  });
});

describe('sign-mobile → POST /auth/native/sign/logout', () => {
  it('revokes this device session (204)', async () => {
    await provider
      .addInteraction()
      .given('a native device session exists')
      .uponReceiving('a native logout')
      .withRequest('POST', '/auth/native/sign/logout', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({ refresh_token: PACT_NATIVE_REFRESH });
      })
      .willRespondWith(204)
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/auth/native/sign/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: PACT_NATIVE_REFRESH }),
        });
        expect(res.status).toBe(204);
      });
  });
});

describe('sign-mobile → /auth/native/sign/sessions', () => {
  it('lists the caller\'s native device sessions (200, Bearer)', async () => {
    await provider
      .addInteraction()
      .given('a native device session exists')
      .uponReceiving('a native device session listing')
      .withRequest('GET', '/auth/native/sign/sessions', (b) => {
        b.headers({ Authorization: PACT_NATIVE_BEARER, 'X-Aramo-Consumer': 'sign' });
      })
      .willRespondWith(200, (b) => {
        b.headers({ 'Cache-Control': 'no-store' }).jsonBody({
          items: eachLike({
            device_session_id: uuid('0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a10'),
            platform: regex('ios|android', 'ios'),
            app_version: like('1.0.0'),
            created_at: datetime("yyyy-MM-dd'T'HH:mm:ss.SSSX", '2026-10-25T10:00:00.000Z'),
            last_seen_at: datetime("yyyy-MM-dd'T'HH:mm:ss.SSSX", '2026-10-25T10:00:00.000Z'),
            current: boolean(true),
          }),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/auth/native/sign/sessions`, {
          headers: { Authorization: PACT_NATIVE_BEARER, 'X-Aramo-Consumer': 'sign' },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: Array<{ current: boolean }> };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });

  it('requires a Bearer token (401 AUTH_REQUIRED)', async () => {
    await provider
      .addInteraction()
      .given('no setup required')
      .uponReceiving('a native device session listing without a Bearer token')
      .withRequest('GET', '/auth/native/sign/sessions')
      .willRespondWith(401, (b) => {
        b.jsonBody(errorBody('AUTH_REQUIRED', 'bearer_required'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/auth/native/sign/sessions`);
        expect(res.status).toBe(401);
      });
  });

  it('answers 404 for a device session that is not the caller\'s', async () => {
    await provider
      .addInteraction()
      .given('a native device session exists')
      .uponReceiving('a native device session revoke for a session the caller does not own')
      .withRequest('DELETE', `/auth/native/sign/sessions/${UNKNOWN_SESSION}`, (b) => {
        b.headers({ Authorization: PACT_NATIVE_BEARER, 'X-Aramo-Consumer': 'sign' });
      })
      .willRespondWith(404, (b) => {
        b.jsonBody(errorBody('NOT_FOUND', 'device_session_not_found'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/auth/native/sign/sessions/${UNKNOWN_SESSION}`, {
          method: 'DELETE',
          headers: { Authorization: PACT_NATIVE_BEARER, 'X-Aramo-Consumer': 'sign' },
        });
        expect(res.status).toBe(404);
      });
  });
});
