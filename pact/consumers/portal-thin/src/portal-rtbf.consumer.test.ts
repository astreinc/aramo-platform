import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like, uuid } = MatchersV3;

// Portal P4 P4b (§PR-2, D-3) — Pact consumer test for the portal-thin client on the
// RTBF surface. Provider: aramo-core (apps/api). The MANDATORY, NON-DESTRUCTIVE
// interaction: a grave-confirm MISMATCH — the caller re-types the wrong email, the
// server refuses with 400 (VALIDATION_ERROR / invalid_field: confirmation) and
// erases NOTHING (the confirm check returns before any deletion). This pins the
// wire contract without touching the destructive path (that is covered end-to-end
// by the portal-p4b-rtbf full-circle integration test).

const provider = new PactV4({
  consumer: 'portal-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const IDEMPOTENCY_KEY = 'cccccccc-cccc-7ccc-8ccc-ccccccccccd1';

describe('portal-thin consumer → POST /v1/portal/rights/erase', () => {
  it('refuses with 400 when the confirmation email does not match (deletes nothing)', async () => {
    await provider
      .addInteraction()
      // The seeded PortalUser's email is portal-thin@example.com; a different
      // confirmation cannot match → the grave-confirm refuses.
      .given('a portal user with no records exists')
      .uponReceiving('an RTBF erase with a non-matching confirmation')
      .withRequest('POST', '/v1/portal/rights/erase', (b) => {
        b.headers({
          Authorization: 'Bearer eyJfake.portal.token',
          'Idempotency-Key': IDEMPOTENCY_KEY,
          'Content-Type': 'application/json',
        });
        b.jsonBody({ confirmation: 'not-my-address@example.com' });
      })
      .willRespondWith(400, (b) => {
        b.jsonBody({
          error: {
            code: 'VALIDATION_ERROR',
            message: like('confirmation does not match'),
            request_id: uuid(),
            details: like({ invalid_field: 'confirmation' }),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/portal/rights/erase`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer eyJfake.portal.token',
            'Idempotency-Key': IDEMPOTENCY_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ confirmation: 'not-my-address@example.com' }),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('VALIDATION_ERROR');
      });
  });
});
