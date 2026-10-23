import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid } = MatchersV3;

// Portal P1 PR-2a/2b → ATI-SEP-1 Addendum A4 (GAP-PORTAL-ID-1) — Pact consumer
// test for the portal-thin client on the records surface. Provider: aramo-core
// (apps/api). The legacy portal identity chain is retired and the Portal identity
// increment is deferred (A4: accepted degradation), so a portal session resolves
// no talent and GET /v1/portal/records answers ONE uniform, non-leaking 404
// NOT_AVAILABLE. The consumer-type (403) and token (401) checks are unchanged.

const provider = new PactV4({
  consumer: 'portal-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

describe('portal-thin consumer → GET /v1/portal/records', () => {
  it('returns the uniform 404 NOT_AVAILABLE while portal identity is deferred (A4)', async () => {
    await provider
      .addInteraction()
      .given('a portal user with no records exists')
      .uponReceiving('a portal records request')
      .withRequest('GET', '/v1/portal/records', (b) => {
        // Exact (not like()) so the fingerprint differs from the 403/401 cases.
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
        const res = await fetch(`${mock.url}/v1/portal/records`, {
          method: 'GET',
          headers: { Authorization: 'Bearer eyJfake.portal.token' },
        });
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string; details: { reason: string } } };
        expect(body.error.code).toBe('NOT_FOUND');
        expect(body.error.details.reason).toBe('NOT_AVAILABLE');
      });
  });

  it('returns 403 INSUFFICIENT_PERMISSIONS for a non-portal consumer', async () => {
    await provider
      .addInteraction()
      .given('a recruiter token (non-portal consumer)')
      .uponReceiving('a portal records request from a recruiter')
      .withRequest('GET', '/v1/portal/records', (b) => {
        b.headers({ Authorization: 'Bearer eyJfake.recruiter.token' });
      })
      .willRespondWith(403, (b) => {
        b.jsonBody({
          // INSUFFICIENT_PERMISSIONS is a superset envelope (RolesGuard OR the
          // controller consumer_type check); the thin consumer depends only on
          // 403 + code + a details object (subset-asserted via like({})).
          error: {
            code: 'INSUFFICIENT_PERMISSIONS',
            message: like('insufficient permissions for portal endpoint'),
            request_id: uuid(),
            details: like({}),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/portal/records`, {
          method: 'GET',
          headers: { Authorization: 'Bearer eyJfake.recruiter.token' },
        });
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      });
  });

  it('returns 401 when unauthenticated', async () => {
    await provider
      .addInteraction()
      .given('no valid token')
      .uponReceiving('an unauthenticated portal records request')
      .withRequest('GET', '/v1/portal/records', (b) => {
        b.headers({ Authorization: 'Bearer not-a-jwt' });
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
        const res = await fetch(`${mock.url}/v1/portal/records`, {
          method: 'GET',
          headers: { Authorization: 'Bearer not-a-jwt' },
        });
        expect(res.status).toBe(401);
      });
  });
});
