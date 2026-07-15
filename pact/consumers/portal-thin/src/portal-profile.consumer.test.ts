import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid } = MatchersV3;

// Portal P1 PR-2a — Pact consumer test for the portal-thin client on the OPEN-4
// records surface (the old singleton /v1/portal/profile is removed). Provider:
// aramo-core (apps/api). Three interactions for GET /v1/portal/records: 200
// empty-list (a portal user with no records — the empty-state-valid contract),
// 403 INSUFFICIENT_PERMISSIONS (non-portal consumer), 401 (unauthenticated).
// The full-chain positive shape is PR-2b's deeper pact (minimal pact rides with
// 2a per the boundary ruling).

const provider = new PactV4({
  consumer: 'portal-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

describe('portal-thin consumer → GET /v1/portal/records', () => {
  it('returns 200 with an empty records envelope for a portal user with no records', async () => {
    await provider
      .addInteraction()
      .given('a portal user with no records exists')
      .uponReceiving('a portal records request')
      .withRequest('GET', '/v1/portal/records', (b) => {
        // Exact (not like()) so the fingerprint differs from the 403/401 cases.
        b.headers({ Authorization: 'Bearer eyJfake.portal.token' });
      })
      .willRespondWith(200, (b) => {
        // Empty-state-valid: the closed envelope with an empty records array.
        b.jsonBody({ records: [] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/portal/records`, {
          method: 'GET',
          headers: { Authorization: 'Bearer eyJfake.portal.token' },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { records: unknown[] };
        expect(Array.isArray(body.records)).toBe(true);
        expect(body.records).toHaveLength(0);
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
