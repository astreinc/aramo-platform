import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  ISO_TIMESTAMP,
  errorBody,
  like,
  makeAtsWebProvider,
  regex,
} from './support/ats-web-pact.js';

// PC-7b — ats-web tenant domain-verification (DNS-TXT). tenant:admin:domain +
// core. State machine UNVERIFIED → PENDING → VERIFIED (request mints a token;
// check compares DNS). Pinned: GET (unverified) + POST request (→PENDING) +
// the no-token check refusal (400, no external DNS). The verified transition
// depends on a live DNS TXT match → out of the deterministic pin surface.
// idempotency 0-by-substrate.

const provider = makeAtsWebProvider();

describe('ats-web → tenant domain-verification', () => {
  it('GET returns the unverified status', async () => {
    await provider
      .addInteraction()
      .given('an ats-web admin and a tenant exist')
      .uponReceiving('a domain-verification read (unverified)')
      .withRequest('GET', '/v1/tenant/domain-verification', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          status: 'UNVERIFIED',
          allowed_domain: null,
          record_name: null,
          record_value: null,
          verified_at: null,
          token_issued_at: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/domain-verification`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string };
        expect(body.status).toBe('UNVERIFIED');
      });
  });

  it('POST issues a token and moves to PENDING', async () => {
    await provider
      .addInteraction()
      .given('an ats-web admin and an allowed domain exist')
      .uponReceiving('a domain-verification request')
      .withRequest('POST', '/v1/tenant/domain-verification', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          status: 'PENDING',
          allowed_domain: like('astre.example'),
          record_name: like('_aramo-verify.astre.example'),
          record_value: like('aramo-verify=token'),
          verified_at: null,
          token_issued_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tenant/domain-verification`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string };
        expect(body.status).toBe('PENDING');
      });
  });

  it('POST check without an issued token returns 400', async () => {
    await provider
      .addInteraction()
      .given('an ats-web admin and a tenant exist')
      .uponReceiving('a domain-verification check with no token issued')
      .withRequest('POST', '/v1/tenant/domain-verification/check', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(400, (b) => {
        b.jsonBody(errorBody('VALIDATION_ERROR', 'no verification token has been issued'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/tenant/domain-verification/check`,
          { method: 'POST', headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('VALIDATION_ERROR');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
