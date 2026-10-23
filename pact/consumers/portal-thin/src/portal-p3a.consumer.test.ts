import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like } = MatchersV3;

// Portal P3a → ATI-SEP-1 Addendum A4 (GAP-PORTAL-ID-1) — pact for the portal-thin
// client on the verification-view + dispute surface. Provider: aramo-core
// (apps/api). Disputes and verifications moved to Talent Intelligence and the
// Portal identity increment is deferred, so every portal caller gets ONE uniform
// 404 NOT_AVAILABLE; a non-portal consumer is still 403.

const IDEMPOTENCY_KEY = 'cccccccc-cccc-7ccc-8ccc-ccccccccccc8';
const BOGUS_ITEM_ID = 'f'.repeat(64);

const provider = new PactV4({
  consumer: 'portal-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

describe('portal-thin consumer → GET /v1/portal/verifications', () => {
  it('returns the uniform 404 NOT_AVAILABLE while portal identity is deferred (A4)', async () => {
    await provider
      .addInteraction()
      .given('a portal user with no records exists')
      .uponReceiving('a portal verifications request while portal identity is deferred')
      .withRequest('GET', '/v1/portal/verifications', (b) => {
        b.headers({ Authorization: 'Bearer eyJfake.portal.token' });
      })
      .willRespondWith(404, (b) => {
        b.jsonBody({
          error: {
            code: 'NOT_FOUND',
            message: like('not available'),
            request_id: like('00000000-0000-7000-8000-000000000000'),
            details: { reason: 'NOT_AVAILABLE' },
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/portal/verifications`, {
          method: 'GET',
          headers: { Authorization: 'Bearer eyJfake.portal.token' },
        });
        expect(res.status).toBe(404);
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
  it('returns the uniform 404 NOT_AVAILABLE for a dispute-open while portal identity is deferred', async () => {
    await provider
      .addInteraction()
      .given('a portal user with no records exists')
      .uponReceiving('a portal dispute-open while portal identity is deferred')
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
            message: like('not available'),
            request_id: like('00000000-0000-7000-8000-000000000000'),
            details: { reason: 'NOT_AVAILABLE' },
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
