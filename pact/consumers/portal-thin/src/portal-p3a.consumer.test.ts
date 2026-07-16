import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like } = MatchersV3;

// Portal P3a — pact for the portal-thin client on the verification-view + dispute
// surface. Provider: aramo-core (apps/api). These interactions reuse existing
// provider states (no new seed): a portal user with no cluster gets an EMPTY
// verification list + a uniform 404 on dispute-open (the item id cannot resolve);
// a non-portal consumer is 403. The positive one-item + open-201 flow is proven
// by the apps/api integration spec (the item id is an HMAC surrogate the thin
// consumer cannot mint without the pepper).

const IDEMPOTENCY_KEY = 'cccccccc-cccc-7ccc-8ccc-ccccccccccc8';
const BOGUS_ITEM_ID = 'f'.repeat(64);

const provider = new PactV4({
  consumer: 'portal-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

describe('portal-thin consumer → GET /v1/portal/verifications', () => {
  it('returns an empty verification list for a portal user with no cluster', async () => {
    await provider
      .addInteraction()
      .given('a portal user with no records exists')
      .uponReceiving('a portal verifications request for a user with no cluster')
      .withRequest('GET', '/v1/portal/verifications', (b) => {
        b.headers({ Authorization: 'Bearer eyJfake.portal.token' });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ verifications: [] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/portal/verifications`, {
          method: 'GET',
          headers: { Authorization: 'Bearer eyJfake.portal.token' },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { verifications: unknown[] };
        expect(body.verifications).toHaveLength(0);
      });
  });

  it('returns 403 for a non-portal consumer', async () => {
    await provider
      .addInteraction()
      .given('a recruiter token (non-portal consumer)')
      .uponReceiving('a portal verifications request from a recruiter')
      .withRequest('GET', '/v1/portal/verifications', (b) => {
        b.headers({ Authorization: 'Bearer eyJfake.recruiter.token' });
      })
      .willRespondWith(403, (b) => {
        b.jsonBody({
          error: {
            code: 'INSUFFICIENT_PERMISSIONS',
            message: like('insufficient permissions for portal endpoint'),
            request_id: like('00000000-0000-7000-8000-000000000000'),
            details: like({}),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/portal/verifications`, {
          method: 'GET',
          headers: { Authorization: 'Bearer eyJfake.recruiter.token' },
        });
        expect(res.status).toBe(403);
      });
  });
});

describe('portal-thin consumer → POST /v1/portal/disputes', () => {
  it('returns a uniform 404 when the item id cannot resolve in the caller view', async () => {
    await provider
      .addInteraction()
      .given('a portal user with no records exists')
      .uponReceiving('a portal dispute-open for an unresolvable item')
      .withRequest('POST', '/v1/portal/disputes', (b) => {
        b.headers({
          Authorization: 'Bearer eyJfake.portal.token',
          'Idempotency-Key': IDEMPOTENCY_KEY,
          'Content-Type': 'application/json',
        });
        b.jsonBody({ item_id: BOGUS_ITEM_ID, statement: 'x' });
      })
      .willRespondWith(404, (b) => {
        b.jsonBody({
          error: {
            code: 'NOT_FOUND',
            message: like('not found'),
            request_id: like('00000000-0000-7000-8000-000000000000'),
            details: like({}),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/portal/disputes`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.portal.token',
            'Idempotency-Key': IDEMPOTENCY_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ item_id: BOGUS_ITEM_ID, statement: 'x' }),
        });
        expect(res.status).toBe(404);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
      });
  });
});
