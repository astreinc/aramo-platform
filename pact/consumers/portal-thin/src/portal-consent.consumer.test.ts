import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid } = MatchersV3;

// Portal P1 PR-2a → ATI-SEP-1 Addendum A4 (GAP-PORTAL-ID-1) — Pact consumer test
// for the portal-thin client on the per-record consent surface. Provider:
// aramo-core (apps/api). With portal identity deferred, every portal caller gets
// ONE uniform 404 NOT_AVAILABLE (read + grant + revoke); a non-portal consumer
// still gets 403.

const provider = new PactV4({
  consumer: 'portal-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

// A well-formed record id — no portal session resolves any record (A4) → uniform 404.
const RECORD_ID = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const NOT_AVAILABLE_BODY = {
  error: {
    code: 'NOT_FOUND',
    message: like('not available'),
    request_id: like('00000000-0000-7000-8000-000000000000'),
    details: { reason: 'NOT_AVAILABLE' },
  },
};
const IDEMPOTENCY_KEY = 'cccccccc-cccc-7ccc-8ccc-ccccccccccc9';

describe('portal-thin consumer → GET /v1/portal/records/{id}/consent', () => {
  it('returns the uniform 404 NOT_AVAILABLE for a record consent read', async () => {
    await provider
      .addInteraction()
      .given('a portal user with no records exists')
      .uponReceiving('a portal record consent request')
      .withRequest('GET', `/v1/portal/records/${RECORD_ID}/consent`, (b) => {
        b.headers({ Authorization: 'Bearer eyJfake.portal.token' });
      })
      .willRespondWith(404, (b) => {
        b.jsonBody(NOT_AVAILABLE_BODY);
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/portal/records/${RECORD_ID}/consent`,
          { method: 'GET', headers: { Authorization: 'Bearer eyJfake.portal.token' } },
        );
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('NOT_FOUND');
      });
  });

  it('returns 403 INSUFFICIENT_PERMISSIONS for a non-portal consumer', async () => {
    await provider
      .addInteraction()
      .given('an ingestion-consumer token (non-portal)')
      .uponReceiving('a portal record consent request from a non-portal consumer')
      .withRequest('GET', `/v1/portal/records/${RECORD_ID}/consent`, (b) => {
        b.headers({ Authorization: 'Bearer eyJfake.ingestion.token' });
      })
      .willRespondWith(403, (b) => {
        b.jsonBody({
          error: {
            code: 'INSUFFICIENT_PERMISSIONS',
            message: like('insufficient permissions for portal endpoint'),
            request_id: uuid(),
            details: like({}),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/portal/records/${RECORD_ID}/consent`,
          { method: 'GET', headers: { Authorization: 'Bearer eyJfake.ingestion.token' } },
        );
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      });
  });
});

// Portal P2 P2a → ATI-SEP-1 A4 — the portal-actor consent grant/revoke mutations
// cannot resolve a record while portal identity is deferred: the uniform 404.
describe('portal-thin consumer → POST /v1/portal/records/{id}/consent/{grant,revoke}', () => {
  for (const action of ['grant', 'revoke'] as const) {
    it(`answers the uniform 404 NOT_AVAILABLE for a consent ${action}`, async () => {
      await provider
        .addInteraction()
        .given('a portal user with no records exists')
        .uponReceiving(`a portal consent ${action} while portal identity is deferred`)
        .withRequest('POST', `/v1/portal/records/${RECORD_ID}/consent/${action}`, (b) => {
          b.headers({
            Authorization: 'Bearer eyJfake.portal.token',
            'Idempotency-Key': IDEMPOTENCY_KEY,
            'Content-Type': 'application/json',
          });
          b.jsonBody({ scope: 'matching' });
        })
        .willRespondWith(404, (b) => {
          b.jsonBody(NOT_AVAILABLE_BODY);
        })
        .executeTest(async (mock) => {
          const res = await fetch(`${mock.url}/v1/portal/records/${RECORD_ID}/consent/${action}`, {
            method: 'POST',
            headers: {
              Authorization: 'Bearer eyJfake.portal.token',
              'Idempotency-Key': IDEMPOTENCY_KEY,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ scope: 'matching' }),
          });
          expect(res.status).toBe(404);
          expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
        });
    });
  }
});
