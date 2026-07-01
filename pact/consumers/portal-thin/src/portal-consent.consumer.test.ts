import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid, regex, eachLike, boolean } = MatchersV3;

// M3 PR-9 §4.7 — Pact consumer test for the portal-thin client.
// Provider: aramo-core (apps/api). Two interactions for GET
// /v1/portal/consent: happy 200, 403 INSUFFICIENT_PERMISSIONS on
// non-portal consumer.
//
// Response shape is the existing TalentConsentStateResponse from
// libs/consent (reused, not redefined) — always-5-scopes deterministic
// shape per PR-5 Decision D.

const provider = new PactV4({
  consumer: 'portal-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const TALENT_SUB = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

describe('portal-thin consumer → GET /v1/portal/consent', () => {
  it('returns 200 with the talent\'s own TalentConsentStateResponse (all 5 scopes)', async () => {
    await provider
      .addInteraction()
      .given('a portal talent with consent grants G exists')
      .uponReceiving('a portal consent state request')
      .withRequest('GET', '/v1/portal/consent', (b) => {
        b.headers({
          // Exact (not like()) so fingerprint differs from the 403 case.
          Authorization: 'Bearer eyJfake.portal.token',
        });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          talent_record_id: uuid(TALENT_SUB),
          tenant_id: uuid(TENANT_ID),
          is_anonymized: boolean(false),
          computed_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
            '2026-05-01T12:00:00Z',
          ),
          scopes: eachLike({
            scope: regex(
              'profile_storage|resume_processing|matching|contacting|cross_tenant_visibility',
              'matching',
            ),
            status: regex('granted|revoked|expired|no_grant', 'granted'),
            granted_at: regex(
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
              '2026-04-01T10:00:00Z',
            ),
            revoked_at: null,
            expires_at: null,
          }),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/portal/consent`, {
          method: 'GET',
          headers: { Authorization: 'Bearer eyJfake.portal.token' },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          talent_record_id: string;
          tenant_id: string;
          is_anonymized: boolean;
          scopes: unknown[];
        };
        expect(body.is_anonymized).toBe(false);
        expect(Array.isArray(body.scopes)).toBe(true);
      });
  });

  it('returns 403 INSUFFICIENT_PERMISSIONS for a non-portal consumer', async () => {
    await provider
      .addInteraction()
      .given('an ingestion-consumer token (non-portal)')
      .uponReceiving('a portal consent request from a non-portal consumer')
      .withRequest('GET', '/v1/portal/consent', (b) => {
        b.headers({ Authorization: 'Bearer eyJfake.ingestion.token' });
      })
      .willRespondWith(403, (b) => {
        b.jsonBody({
          error: {
            // PR-A1a-4 Ruling 1: INSUFFICIENT_PERMISSIONS is a superset
            // envelope. A non-portal token may be rejected by RolesGuard
            // (details:{required_scopes, missing_scopes}) before the
            // controller-body consumer_type check (details:{consumer_type})
            // ever runs. The portal-thin consumer only depends on the
            // 403 + code + the presence of a details object — not on a
            // specific key set — so details is subset-asserted as
            // "an object" via like({}).
            code: 'INSUFFICIENT_PERMISSIONS',
            message: like('insufficient permissions for portal endpoint'),
            request_id: uuid(),
            details: like({}),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/portal/consent`, {
          method: 'GET',
          headers: { Authorization: 'Bearer eyJfake.ingestion.token' },
        });
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      });
  });
});
