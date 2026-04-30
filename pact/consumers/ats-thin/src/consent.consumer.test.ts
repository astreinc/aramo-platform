import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { like, uuid, regex } = MatchersV3;

// PR-2 / PR-3 Pact consumer test for the ATS thin client.
// PR-2 covers /v1/consent/grant.
// PR-3 covers /v1/consent/revoke (canonical contract per Group 2 §2.7).
// Provider verification is deferred until Talent / Tenant entity PRs land.
const provider = new PactV4({
  consumer: 'ats-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const IDEMPOTENCY_KEY = 'd2d7a0f0-0000-7000-8000-000000000001';
const REVOKE_KEY_HAPPY = 'd2d7a0f0-0000-7000-8000-000000000099';
const REVOKE_KEY_NOPRIOR = 'd2d7a0f0-0000-7000-8000-000000000098';
const REVOKE_KEY_CONFLICT = 'd2d7a0f0-0000-7000-8000-000000000097';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a00';
const PRIOR_GRANT_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a01';

const grantBody = {
  talent_id: TALENT_ID,
  scope: 'matching',
  captured_method: 'recruiter_capture',
  consent_version: 'v1',
  occurred_at: '2026-04-29T00:00:00Z',
};

const revokeBody = {
  talent_id: TALENT_ID,
  scope: 'matching',
  captured_method: 'recruiter_capture',
  consent_version: 'v1',
  occurred_at: '2026-04-29T01:00:00Z',
};

describe('ATS thin consumer → POST /v1/consent/grant', () => {
  it('records a grant and returns the locked 201 response shape', async () => {
    await provider
      .addInteraction()
      .given('a valid recruiter token and an ungranted talent')
      .uponReceiving('a consent grant request')
      .withRequest('POST', '/v1/consent/grant', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'Idempotency-Key': IDEMPOTENCY_KEY,
          'Content-Type': 'application/json',
        }).jsonBody(grantBody);
      })
      .willRespondWith(201, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          event_id: uuid(),
          tenant_id: uuid(TENANT_ID),
          talent_id: uuid(TALENT_ID),
          scope: 'matching',
          action: 'granted',
          captured_method: 'recruiter_capture',
          captured_by_actor_id: uuid(),
          consent_version: 'v1',
          occurred_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
            '2026-04-29T00:00:00Z',
          ),
          recorded_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
            '2026-04-29T00:00:01Z',
          ),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/grant`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'Idempotency-Key': IDEMPOTENCY_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(grantBody),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { action: string };
        expect(body.action).toBe('granted');
      });
  });

  it('returns 400 VALIDATION_ERROR when Idempotency-Key is missing', async () => {
    await provider
      .addInteraction()
      .given('a valid recruiter token')
      .uponReceiving('a consent grant request without Idempotency-Key')
      .withRequest('POST', '/v1/consent/grant', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'Content-Type': 'application/json',
        }).jsonBody(grantBody);
      })
      .willRespondWith(400, (b) => {
        b.jsonBody({
          error: {
            code: 'VALIDATION_ERROR',
            message: like('Idempotency-Key header is required'),
            request_id: uuid(),
            details: like({ missing_field: 'Idempotency-Key' }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/grant`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(grantBody),
        });
        expect(res.status).toBe(400);
      });
  });

  it('returns 401 INVALID_TOKEN when the bearer token is malformed', async () => {
    await provider
      .addInteraction()
      .given('no valid token')
      .uponReceiving('a grant request with a malformed bearer token')
      .withRequest('POST', '/v1/consent/grant', (b) => {
        b.headers({
          Authorization: 'Bearer not-a-jwt',
          'Idempotency-Key': IDEMPOTENCY_KEY,
          'Content-Type': 'application/json',
        }).jsonBody(grantBody);
      })
      .willRespondWith(401, (b) => {
        b.jsonBody({
          error: {
            code: 'INVALID_TOKEN',
            message: like('Token verification failed'),
            request_id: uuid(),
            details: like({}),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/grant`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer not-a-jwt',
            'Idempotency-Key': IDEMPOTENCY_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(grantBody),
        });
        expect(res.status).toBe(401);
      });
  });

  it('returns 409 IDEMPOTENCY_KEY_CONFLICT when the same key is replayed with a different body', async () => {
    await provider
      .addInteraction()
      .given('an idempotency key already used with a different body')
      .uponReceiving('a replay grant request with mismatched body')
      .withRequest('POST', '/v1/consent/grant', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'Idempotency-Key': IDEMPOTENCY_KEY,
          'Content-Type': 'application/json',
        }).jsonBody({ ...grantBody, scope: 'contacting' });
      })
      .willRespondWith(409, (b) => {
        b.jsonBody({
          error: {
            code: 'IDEMPOTENCY_KEY_CONFLICT',
            message: like('Same idempotency key used with a different request body'),
            request_id: uuid(),
            details: like({}),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/grant`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'Idempotency-Key': IDEMPOTENCY_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ...grantBody, scope: 'contacting' }),
        });
        expect(res.status).toBe(409);
      });
  });
});

describe('ATS thin consumer → POST /v1/consent/revoke', () => {
  it('records a revoke and returns the locked 201 response shape (with revoked_event_id)', async () => {
    await provider
      .addInteraction()
      .given('a valid recruiter token and a prior grant for talent+scope')
      .uponReceiving('a consent revoke request after a prior grant')
      .withRequest('POST', '/v1/consent/revoke', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'Idempotency-Key': REVOKE_KEY_HAPPY,
          'Content-Type': 'application/json',
        }).jsonBody(revokeBody);
      })
      .willRespondWith(201, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          event_id: uuid(),
          tenant_id: uuid(TENANT_ID),
          talent_id: uuid(TALENT_ID),
          scope: 'matching',
          action: 'revoked',
          captured_method: 'recruiter_capture',
          captured_by_actor_id: uuid(),
          consent_version: 'v1',
          occurred_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
            '2026-04-29T01:00:00Z',
          ),
          recorded_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
            '2026-04-29T01:00:01Z',
          ),
          revoked_event_id: uuid(PRIOR_GRANT_ID),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/revoke`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'Idempotency-Key': REVOKE_KEY_HAPPY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(revokeBody),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { action: string; revoked_event_id: string | null };
        expect(body.action).toBe('revoked');
        expect(body.revoked_event_id).toBeDefined();
      });
  });

  it('records a revoke with no prior grant (revoked_event_id: null per Decision D)', async () => {
    await provider
      .addInteraction()
      .given('a valid recruiter token and no prior grant for talent+scope')
      .uponReceiving('a consent revoke request without a prior grant')
      .withRequest('POST', '/v1/consent/revoke', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'Idempotency-Key': REVOKE_KEY_NOPRIOR,
          'Content-Type': 'application/json',
        }).jsonBody(revokeBody);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          event_id: uuid(),
          tenant_id: uuid(TENANT_ID),
          talent_id: uuid(TALENT_ID),
          scope: 'matching',
          action: 'revoked',
          captured_method: 'recruiter_capture',
          captured_by_actor_id: uuid(),
          consent_version: 'v1',
          occurred_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
            '2026-04-29T01:00:00Z',
          ),
          recorded_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
            '2026-04-29T01:00:01Z',
          ),
          revoked_event_id: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/revoke`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'Idempotency-Key': REVOKE_KEY_NOPRIOR,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(revokeBody),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { action: string; revoked_event_id: string | null };
        expect(body.action).toBe('revoked');
        expect(body.revoked_event_id).toBeNull();
      });
  });

  it('returns 400 VALIDATION_ERROR when Idempotency-Key is missing on revoke', async () => {
    await provider
      .addInteraction()
      .given('a valid recruiter token')
      .uponReceiving('a consent revoke request without Idempotency-Key')
      .withRequest('POST', '/v1/consent/revoke', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'Content-Type': 'application/json',
        }).jsonBody(revokeBody);
      })
      .willRespondWith(400, (b) => {
        b.jsonBody({
          error: {
            code: 'VALIDATION_ERROR',
            message: like('Idempotency-Key header is required'),
            request_id: uuid(),
            details: like({ missing_field: 'Idempotency-Key' }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/revoke`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(revokeBody),
        });
        expect(res.status).toBe(400);
      });
  });

  it('returns 409 IDEMPOTENCY_KEY_CONFLICT when the same key is replayed with a different body', async () => {
    await provider
      .addInteraction()
      .given('a revoke idempotency key already used with a different body')
      .uponReceiving('a replay revoke request with mismatched body')
      .withRequest('POST', '/v1/consent/revoke', (b) => {
        b.headers({
          Authorization: like('Bearer eyJfake.token'),
          'Idempotency-Key': REVOKE_KEY_CONFLICT,
          'Content-Type': 'application/json',
        }).jsonBody({ ...revokeBody, scope: 'contacting' });
      })
      .willRespondWith(409, (b) => {
        b.jsonBody({
          error: {
            code: 'IDEMPOTENCY_KEY_CONFLICT',
            message: like('Same idempotency key used with a different request body'),
            request_id: uuid(),
            details: like({}),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/consent/revoke`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.token',
            'Idempotency-Key': REVOKE_KEY_CONFLICT,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ...revokeBody, scope: 'contacting' }),
        });
        expect(res.status).toBe(409);
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
