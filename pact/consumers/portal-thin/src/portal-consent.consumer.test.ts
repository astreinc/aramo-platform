import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid } = MatchersV3;

// Portal P1 PR-2a — Pact consumer test for the portal-thin client on the
// per-record consent surface (the old singleton /v1/portal/consent is removed).
// Provider: aramo-core (apps/api). Two interactions for
// GET /v1/portal/records/{id}/consent: a UNIFORM 404 for a record id not in the
// caller's chain (the oracle-resistant contract), and 403 for a non-portal
// consumer. The positive consent shape is PR-2b's deeper pact.

const provider = new PactV4({
  consumer: 'portal-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

// A well-formed record id that is NOT in the (empty) chain → uniform 404.
const RECORD_ID = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
// Portal P2 P2a — the IN-CHAIN record id (the provider's seedPortalUserWithOneRecord
// PORTAL_RECORD_ID) for the grant/revoke happy path.
const IN_CHAIN_RECORD_ID = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeee1';
const IDEMPOTENCY_KEY = 'cccccccc-cccc-7ccc-8ccc-ccccccccccc9';

describe('portal-thin consumer → GET /v1/portal/records/{id}/consent', () => {
  it('returns a uniform 404 for a record not in the caller chain', async () => {
    await provider
      .addInteraction()
      .given('a portal user with no records exists')
      .uponReceiving('a portal record consent request for an out-of-chain record')
      .withRequest('GET', `/v1/portal/records/${RECORD_ID}/consent`, (b) => {
        b.headers({ Authorization: 'Bearer eyJfake.portal.token' });
      })
      .willRespondWith(404, (b) => {
        b.jsonBody({
          error: {
            code: 'NOT_FOUND',
            message: like('record not found'),
            request_id: uuid(),
            details: like({}),
          },
        });
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

// Portal P2 P2a — the portal-actor consent grant/revoke mutations.
describe('portal-thin consumer → POST /v1/portal/records/{id}/consent/{grant,revoke}', () => {
  it('grants consent for an in-chain record (201, closed mutation envelope)', async () => {
    await provider
      .addInteraction()
      .given('a portal user with one record exists')
      .uponReceiving('a portal consent grant for an in-chain record')
      .withRequest('POST', `/v1/portal/records/${IN_CHAIN_RECORD_ID}/consent/grant`, (b) => {
        b.headers({
          Authorization: 'Bearer eyJfake.portal.token',
          'Idempotency-Key': IDEMPOTENCY_KEY,
          'Content-Type': 'application/json',
        });
        b.jsonBody({ scope: 'matching' });
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          scope: 'matching',
          action: 'granted',
          occurred_at: like('2026-07-15T00:00:00.000Z'),
          expires_at: like('2027-07-15T00:00:00.000Z'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/portal/records/${IN_CHAIN_RECORD_ID}/consent/grant`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer eyJfake.portal.token',
              'Idempotency-Key': IDEMPOTENCY_KEY,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ scope: 'matching' }),
          },
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as { action: string };
        expect(body.action).toBe('granted');
      });
  });

  it('revokes consent for an in-chain record (201; expires_at null)', async () => {
    await provider
      .addInteraction()
      .given('a portal user with one record exists')
      .uponReceiving('a portal consent revoke for an in-chain record')
      .withRequest('POST', `/v1/portal/records/${IN_CHAIN_RECORD_ID}/consent/revoke`, (b) => {
        b.headers({
          Authorization: 'Bearer eyJfake.portal.token',
          'Idempotency-Key': IDEMPOTENCY_KEY,
          'Content-Type': 'application/json',
        });
        b.jsonBody({ scope: 'matching' });
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          scope: 'matching',
          action: 'revoked',
          occurred_at: like('2026-07-15T00:00:00.000Z'),
          expires_at: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/portal/records/${IN_CHAIN_RECORD_ID}/consent/revoke`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer eyJfake.portal.token',
              'Idempotency-Key': IDEMPOTENCY_KEY,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ scope: 'matching' }),
          },
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as { action: string };
        expect(body.action).toBe('revoked');
      });
  });
});
