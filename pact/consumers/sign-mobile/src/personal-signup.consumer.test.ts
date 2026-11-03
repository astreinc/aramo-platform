import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, eachLike, regex } = MatchersV3;

// Sign Mobile Amendment M-A11 §5 — Pact consumer for the native Personal signup, as the
// Aramo Sign Android app (mobile/sign/src/features/signup/signupApi.ts) calls it.
//
// Consumer:  sign-mobile      (mobile/sign — the native app)
// Provider:  platform-admin   (apps/platform-admin)
//
// Its own pact file (pact/pacts/sign-mobile-platform-admin.json), verified by
// pact/provider/src/verify-platform-admin.ts beside the platform-web consumer. The
// provider binds a test double of the native integrity verifier in that harness only.
// Provider-state names, the fixed codes and the document hashes below MUST match the
// state handlers of verify-platform-admin.ts.
//
// Interactions:
//   1. GET  /v1/signup/sign/personal/terms                         200 (the effective documents)
//   2. GET  /v1/signup/sign/personal/terms/{key}/{version}         200 (bound text)
//   3. GET  /v1/signup/sign/personal/terms/{key}/{version}         404 legal_document_not_found
//   4. POST /v1/signup/sign/personal/start  (client android)       202 { signup_id }
//   5. POST /v1/signup/sign/personal/start  (integrity fails)      400 personal_signup_refused
//   6. POST /v1/signup/sign/personal/verify-email                   200 { next: terms }
//   7. POST /v1/signup/sign/personal/complete (client android)     200 PROVISIONED

const provider = new PactV4({
  consumer: 'sign-mobile',
  provider: 'platform-admin',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const BASE = '/v1/signup/sign/personal';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const SHA256 = /^[0-9a-f]{64}$/.source;
const EMAIL_CODE = '246810';
const SIGNUP_FOR_EMAIL_CODE = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b5a01';
const SIGNUP_FOR_COMPLETE = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b5a02';

// The currently effective Personal documents (key, version, registry sha256).
const EFFECTIVE = [
  {
    key: 'sign.terms_of_service',
    version: '2.0',
    sha256: '6d591f19a7a8064652e0c11b1fdb642ab108c9e339190febd557e902288b0cfb',
  },
  {
    key: 'aramo.privacy_notice',
    version: '1.0',
    sha256: '18fcc1aa386a06c0c9a15b8c60232aca6f0fbb1cdc100b288e524617f6e446b6',
  },
  {
    key: 'aramo.acceptable_use_policy',
    version: '1.0',
    sha256: '2e64f8eece66c50b99954de8b4c885240bc4ca51fa0f6731a7d800b4706a476e',
  },
] as const;

function startBody(email: string) {
  return {
    client: 'android',
    name: 'Pat Mobile',
    email,
    phone: '+14155550123',
    residence: 'US',
    invite_code: null,
    hp: '',
    elapsed_ms: 8423,
    integrity_token: 'pact-play-integrity-token',
  };
}

function errorBody(code: string, reason: string) {
  return {
    error: {
      code,
      message: like('message'),
      request_id: like('req-1'),
      details: { reason },
    },
  };
}

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

describe('sign-mobile → GET /v1/signup/sign/personal/terms', () => {
  it('lists the effective Personal documents (200)', async () => {
    await provider
      .addInteraction()
      .given('personal signup is open')
      .uponReceiving('a native request for the effective Personal documents')
      .withRequest('GET', `${BASE}/terms`)
      .willRespondWith(200, (b) => {
        b.jsonBody({
          documents: eachLike({
            key: like('sign.terms_of_service'),
            version: like('2.0'),
            url: like('https://sign.aramo.ai/legal/terms-of-service/2.0'),
            sha256: regex(SHA256, EFFECTIVE[0].sha256),
          }),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${BASE}/terms`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { documents: Array<{ key: string }> };
        expect(body.documents.length).toBeGreaterThan(0);
      });
  });

  it('returns the bound text of an effective document (200)', async () => {
    const path = `${BASE}/terms/sign.terms_of_service/2.0`;
    await provider
      .addInteraction()
      .given('personal signup is open')
      .uponReceiving('a native request for the text of an effective Personal document')
      .withRequest('GET', path)
      .willRespondWith(200, (b) => {
        b.jsonBody({
          key: 'sign.terms_of_service',
          version: '2.0',
          sha256: regex(SHA256, EFFECTIVE[0].sha256),
          effective_at: like('2026-11-02T17:00:00.000Z'),
          text: like('Aramo Sign Terms of Service'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${path}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { key: string; version: string; text: string };
        expect(body.key).toBe('sign.terms_of_service');
        expect(body.version).toBe('2.0');
        expect(typeof body.text).toBe('string');
      });
  });

  it('answers 404 for a document version that is not currently effective', async () => {
    const path = `${BASE}/terms/sign.terms_of_service/0.1.1`;
    await provider
      .addInteraction()
      .given('personal signup is open')
      .uponReceiving('a native request for the text of a document that is not effective')
      .withRequest('GET', path)
      .willRespondWith(404, (b) => {
        b.jsonBody(errorBody('NOT_FOUND', 'legal_document_not_found'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${path}`);
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { details: { reason: string } } };
        expect(body.error.details.reason).toBe('legal_document_not_found');
      });
  });
});

describe('sign-mobile → POST /v1/signup/sign/personal/start (client android)', () => {
  it('starts a signup with a Play Integrity token (202)', async () => {
    const body = startBody('pact.mobile.start@gmail.com');
    await provider
      .addInteraction()
      .given('personal signup is open')
      .uponReceiving('a native Personal signup start with an integrity token')
      .withRequest('POST', `${BASE}/start`, (b) => {
        b.headers(JSON_HEADERS).jsonBody(body);
      })
      .willRespondWith(202, (b) => {
        b.jsonBody({ signup_id: uuid('0190d5a4-7e01-7e2a-a4d3-3d4f1c2b5a10') });
      })
      .executeTest(async (mock) => {
        const res = await post(`${mock.url}${BASE}/start`, body);
        expect(res.status).toBe(202);
        const json = (await res.json()) as { signup_id: string };
        expect(typeof json.signup_id).toBe('string');
      });
  });

  it('refuses neutrally when the integrity check fails (400 personal_signup_refused)', async () => {
    const body = startBody('pact.mobile.refused@gmail.com');
    await provider
      .addInteraction()
      .given('the native integrity check fails')
      .uponReceiving('a native Personal signup start whose integrity check fails')
      .withRequest('POST', `${BASE}/start`, (b) => {
        b.headers(JSON_HEADERS).jsonBody(body);
      })
      .willRespondWith(400, (b) => {
        b.jsonBody(errorBody('VALIDATION_ERROR', 'personal_signup_refused'));
      })
      .executeTest(async (mock) => {
        const res = await post(`${mock.url}${BASE}/start`, body);
        expect(res.status).toBe(400);
        const json = (await res.json()) as { error: { details: { reason: string } } };
        expect(json.error.details.reason).toBe('personal_signup_refused');
      });
  });
});

describe('sign-mobile → POST /v1/signup/sign/personal/verify-email', () => {
  it('verifies the email code (200 next: terms)', async () => {
    const body = { signup_id: SIGNUP_FOR_EMAIL_CODE, code: EMAIL_CODE };
    await provider
      .addInteraction()
      .given('a personal signup is awaiting its email code', { signup_id: SIGNUP_FOR_EMAIL_CODE })
      .uponReceiving('a native Personal signup email code')
      .withRequest('POST', `${BASE}/verify-email`, (b) => {
        b.headers(JSON_HEADERS).jsonBody(body);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ next: 'terms' });
      })
      .executeTest(async (mock) => {
        const res = await post(`${mock.url}${BASE}/verify-email`, body);
        expect(res.status).toBe(200);
        expect(((await res.json()) as { next: string }).next).toBe('terms');
      });
  });
});

describe('sign-mobile → POST /v1/signup/sign/personal/complete (client android)', () => {
  it('creates the account when every effective document is accepted by key, version and sha256 (200)', async () => {
    const body = {
      signup_id: SIGNUP_FOR_COMPLETE,
      client: 'android',
      accept: EFFECTIVE.map((d) => ({ ...d })),
    };
    await provider
      .addInteraction()
      .given('a personal signup has a verified email', { signup_id: SIGNUP_FOR_COMPLETE })
      .uponReceiving('a native Personal signup completion with hash-bound acceptances')
      .withRequest('POST', `${BASE}/complete`, (b) => {
        b.headers(JSON_HEADERS).jsonBody(body);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          status: 'PROVISIONED',
          email: like('pact.mobile@gmail.com'),
          sign_in: { google: like('https://sign.aramo.ai/auth/signin/google') },
          held: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await post(`${mock.url}${BASE}/complete`, body);
        expect(res.status).toBe(200);
        const json = (await res.json()) as { status: string; held: unknown };
        expect(json.status).toBe('PROVISIONED');
        expect(json.held).toBeNull();
      });
  });
});
