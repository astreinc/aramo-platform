import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  ISO_TIMESTAMP,
  TALENT_ID,
  errorBody,
  like,
  makeAtsWebProvider,
  regex,
  uuid,
} from './support/ats-web-pact.js';

// TR-3 B2 — Pact consumer for ats-web, email-verification domain. Merges into
// ats-web-aramo-core.json.
//
// Scope: 4 interactions —
//   - POST /v1/talent-records/:id/email-verifications -> 200 PENDING (happy;
//     stored SLOT only, Cookie-authed);
//   - same POST -> 403 VERIFICATION_CONSENT_REQUIRED (consent NOT granted);
//   - POST /v1/email-verifications/confirm -> 200 VERIFIED (PUBLIC, NO Cookie —
//     the FIRST no-Cookie interaction in the ats-web suite; the talent has no
//     session, the token in the body is the only authority);
//   - same public confirm -> 404 NOT_FOUND (oracle-resistant: EVERY failure —
//     bad / expired / consumed / rotated / missing token, or rate-limited —
//     returns ONE identical NOT_FOUND envelope; there are NO distinct reason
//     codes, so the consumer pins exactly one failure shape).
//
// The request body carries a stored SLOT ('email1'|'email2'), never a free-form
// address. status is a band/label, never a numeric value.
//
// Guard chain (authenticated pair): @RequireCapability('core') +
// @RequireScopes('talent:edit'). The public confirm is un-guarded (no Cookie).

const provider = makeAtsWebProvider();

// ======================================================================
// POST /v1/talent-records/:id/email-verifications — happy (authenticated)
// ======================================================================
describe('ats-web → POST /v1/talent-records/:id/email-verifications', () => {
  it('returns 200 PENDING for a stored email slot with consent granted', async () => {
    await provider
      .addInteraction()
      .given(
        'an ats-web recruiter and a live talent record with a stored email and consent granted',
      )
      .uponReceiving('a request to verify a stored email slot')
      .withRequest(
        'POST',
        `/v1/talent-records/${TALENT_ID}/email-verifications`,
        (b) => {
          b.headers({
            Cookie: like(ACCESS_COOKIE),
            'Content-Type': 'application/json',
          }).jsonBody({ slot: 'email1' });
        },
      )
      .willRespondWith(200, (b) => {
        b.jsonBody({
          verification_id: uuid(),
          slot: 'email1',
          status: 'PENDING',
          expires_at: regex(ISO_TIMESTAMP, '2026-07-10T00:00:00.000Z'),
          resent: like(false),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/talent-records/${TALENT_ID}/email-verifications`,
          {
            method: 'POST',
            headers: {
              Cookie: ACCESS_COOKIE,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ slot: 'email1' }),
          },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { slot: string; status: string };
        expect(body.slot).toBe('email1');
        expect(body.status).toBe('PENDING');
      });
  });

  it('returns 403 VERIFICATION_CONSENT_REQUIRED when consent is not granted', async () => {
    await provider
      .addInteraction()
      .given(
        'an ats-web recruiter and a live talent record with consent NOT granted',
      )
      .uponReceiving('a verify request refused for missing consent')
      .withRequest(
        'POST',
        `/v1/talent-records/${TALENT_ID}/email-verifications`,
        (b) => {
          b.headers({
            Cookie: like(ACCESS_COOKIE),
            'Content-Type': 'application/json',
          }).jsonBody({ slot: 'email1' });
        },
      )
      .willRespondWith(403, (b) => {
        b.jsonBody(
          errorBody(
            'VERIFICATION_CONSENT_REQUIRED',
            'consent required to send a verification email',
          ),
        );
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/talent-records/${TALENT_ID}/email-verifications`,
          {
            method: 'POST',
            headers: {
              Cookie: ACCESS_COOKIE,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ slot: 'email1' }),
          },
        );
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('VERIFICATION_CONSENT_REQUIRED');
      });
  });
});

// ======================================================================
// POST /v1/email-verifications/confirm — PUBLIC (NO Cookie)
// ======================================================================
describe('ats-web → POST /v1/email-verifications/confirm', () => {
  it('returns 200 VERIFIED for a valid token (no Cookie)', async () => {
    await provider
      .addInteraction()
      .given('a pending email-verification token exists')
      .uponReceiving('a public confirm of a valid verification token')
      .withRequest('POST', '/v1/email-verifications/confirm', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({
          token: like('a-valid-raw-token'),
        });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ status: 'VERIFIED' });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/email-verifications/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: 'a-valid-raw-token' }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string };
        expect(body.status).toBe('VERIFIED');
      });
  });

  it('returns 404 NOT_FOUND for an invalid or expired token (oracle-resistant, no Cookie)', async () => {
    await provider
      .addInteraction()
      .given('no matching email-verification token exists')
      .uponReceiving('a public confirm of an invalid or expired verification token')
      .withRequest('POST', '/v1/email-verifications/confirm', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({
          token: like('a-bad-token'),
        });
      })
      .willRespondWith(404, (b) => {
        b.jsonBody(errorBody('NOT_FOUND', 'verification not found'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/email-verifications/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: 'a-bad-token' }),
        });
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('NOT_FOUND');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
