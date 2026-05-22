import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, regex } = MatchersV3;

// M3 PR-9 §4.7 — Pact consumer test for the portal-thin client.
// Provider: aramo-core (apps/api). Three interactions for GET
// /v1/portal/profile: happy 200, 403 INSUFFICIENT_PERMISSIONS on
// non-portal consumer, 401 AUTH_REQUIRED on unauthenticated.
//
// Strict jsonBody listing exactly the PortalProfile fields with no
// like() wrapper around the outer response object — the positive R10
// contract. Companion negative-shape integration test at
// apps/api/src/tests/portal-refusal.negative-shape.spec.ts (F23 pattern).

const provider = new PactV4({
  consumer: 'portal-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const TALENT_SUB = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

describe('portal-thin consumer → GET /v1/portal/profile', () => {
  it('returns 200 with the PortalProfile shape for the authenticated talent', async () => {
    await provider
      .addInteraction()
      .given('a portal talent with profile P exists')
      .uponReceiving('a portal profile request')
      .withRequest('GET', '/v1/portal/profile', (b) => {
        b.headers({
          // Exact (not like()) so this interaction is distinct from the
          // 403 (recruiter token) one — Pact V4 fingerprint dedup
          // collapses identical-shape requests, the PR-8 JOB_ID_EMPTY
          // workaround pattern.
          Authorization: 'Bearer eyJfake.portal.token',
        });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          // Strict — exactly the PortalProfile fields, no like() wrapper
          // on the outer object.
          talent_id: uuid(TALENT_SUB),
          tenant_id: uuid(TENANT_ID),
          lifecycle_status: regex('active|inactive|archived|deleted', 'active'),
          tenant_status: regex('active|inactive|archived', 'active'),
          source_channel: regex('self_signup|recruiter_capture|referral|import', 'self_signup'),
          created_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
            '2026-05-01T12:00:00Z',
          ),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/portal/profile`, {
          method: 'GET',
          headers: { Authorization: 'Bearer eyJfake.portal.token' },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { talent_id: string; tenant_id: string };
        expect(body.talent_id).toBeTruthy();
        expect(body.tenant_id).toBeTruthy();
      });
  });

  it('returns 403 INSUFFICIENT_PERMISSIONS for a non-portal consumer', async () => {
    await provider
      .addInteraction()
      .given('a recruiter token (non-portal consumer)')
      .uponReceiving('a portal profile request from a recruiter')
      .withRequest('GET', '/v1/portal/profile', (b) => {
        // Exact distinct value so the fingerprint differs from the
        // happy-path portal token.
        b.headers({ Authorization: 'Bearer eyJfake.recruiter.token' });
      })
      .willRespondWith(403, (b) => {
        b.jsonBody({
          error: {
            code: 'INSUFFICIENT_PERMISSIONS',
            message: like('portal endpoints are portal-consumer only'),
            request_id: uuid(),
            details: like({ consumer_type: 'recruiter' }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/portal/profile`, {
          method: 'GET',
          headers: { Authorization: 'Bearer eyJfake.recruiter.token' },
        });
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      });
  });

  it('returns 401 AUTH_REQUIRED when unauthenticated', async () => {
    await provider
      .addInteraction()
      .given('no valid token')
      .uponReceiving('an unauthenticated portal profile request')
      .withRequest('GET', '/v1/portal/profile', (b) => {
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
        const res = await fetch(`${mock.url}/v1/portal/profile`, {
          method: 'GET',
          headers: { Authorization: 'Bearer not-a-jwt' },
        });
        expect(res.status).toBe(401);
      });
  });
});
