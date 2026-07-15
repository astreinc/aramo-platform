import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, eachLike } = MatchersV3;

// Portal P1 PR-2a/2b — Pact consumer test for the portal-thin client on the
// OPEN-4 records surface (the old singleton /v1/portal/profile is removed).
// Provider: aramo-core (apps/api). Interactions for GET /v1/portal/records:
//   - 200 empty-list (a portal user with no records — the empty-state contract);
//   - 200 one-record POSITIVE SHAPE (PR-2b — the deferred full-chain residue:
//     the closed PortalProfile envelope, R10-clean);
//   - 403 INSUFFICIENT_PERMISSIONS (non-portal consumer);
//   - 401 (unauthenticated).
// The 200-empty and 200-one-record cases share the request; the provider STATE
// (given) disambiguates them at verification.

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

  it('returns 200 with the PortalProfile envelope for a portal user with one record', async () => {
    await provider
      .addInteraction()
      .given('a portal user with one record exists')
      .uponReceiving('a portal records request resolving one record')
      .withRequest('GET', '/v1/portal/records', (b) => {
        b.headers({ Authorization: 'Bearer eyJfake.portal.token' });
      })
      .willRespondWith(200, (b) => {
        // The closed PortalProfile envelope — exactly the 5 R10-safe fields.
        b.jsonBody({
          records: eachLike({
            talent_id: uuid(),
            tenant_id: uuid(),
            tenant_status: like('active'),
            source_channel: like('self_signup'),
            created_at: like('2026-05-01T12:00:00.000Z'),
          }),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/portal/records`, {
          method: 'GET',
          headers: { Authorization: 'Bearer eyJfake.portal.token' },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          records: Array<Record<string, unknown>>;
        };
        expect(Array.isArray(body.records)).toBe(true);
        expect(body.records.length).toBeGreaterThanOrEqual(1);
        const rec = body.records[0]!;
        // Positive shape: the 5 fields present …
        for (const f of ['talent_id', 'tenant_id', 'tenant_status', 'source_channel', 'created_at']) {
          expect(rec).toHaveProperty(f);
        }
        // … and NO trust/verification origin data (D3 / P-R4).
        for (const f of ['tenant_name', 'verifier', 'verified_by', 'attestation']) {
          expect(rec).not.toHaveProperty(f);
        }
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
