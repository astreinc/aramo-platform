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

// TR-3 B2 → ATI-SEP-1 T10 WP3b (Addendum A3 T10-3) — Pact consumer for ats-web,
// email-verification domain. Verification is a 6-digit ONE-TIME CODE minted,
// delivered and checked by Talent Intelligence; the ATS relays. The legacy
// token-link flow is retired. Merges into ats-web-aramo-core.json.
//
// Scope: 7 interactions —
//   - POST /v1/talent-records/:id/email-verifications { slot } → 200 PENDING
//     (the STORED slot only, Cookie-authed, TI enabled);
//   - same POST → 403 VERIFICATION_CONSENT_REQUIRED (consent NOT granted — gated
//     before any TI call);
//   - same POST → 503 INTELLIGENCE_UNAVAILABLE (TI not enabled for the tenant);
//   - GET  /v1/talent-records/:id/email-verifications → per-slot status (words);
//   - POST /v1/email-verifications/confirm { verification_id, code } → 200
//     VERIFIED (PUBLIC, NO Cookie — the talent has no session);
//   - same confirm, wrong code → 422 IDENTIFIER_VERIFICATION_REFUSED
//     (details.reason INVALID_CODE + attempts_remaining);
//   - same confirm, unknown id → 404 NOT_FOUND (uniform).
//
// The request body names a stored SLOT ('email1'|'email2'), never a free-form
// address. Statuses are words, never numbers. Guard chain (authenticated):
// @RequireCapability('ats') + talent:edit (request) / talent:read (status).

const provider = makeAtsWebProvider();

const VERIFICATION_ID = '00000000-0000-7000-8000-7e0000000002';
const UNKNOWN_VERIFICATION_ID = '00000000-0000-7000-8000-7e00000000ff';

async function postRequest(url: string): Promise<Response> {
  return fetch(`${url}/v1/talent-records/${TALENT_ID}/email-verifications`, {
    method: 'POST',
    headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slot: 'email1' }),
  });
}

describe('ats-web → POST /v1/talent-records/:id/email-verifications', () => {
  it('returns 200 PENDING for a stored email slot with consent granted', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a live talent record with a stored email and consent granted')
      .uponReceiving('a request to send a one-time code to a stored email slot')
      .withRequest('POST', `/v1/talent-records/${TALENT_ID}/email-verifications`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody({ slot: 'email1' });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          verification_id: uuid(VERIFICATION_ID),
          slot: 'email1',
          status: 'PENDING',
          expires_at: regex(ISO_TIMESTAMP, '2026-07-10T00:10:00.000Z'),
          delivery: like('QUEUED'),
        });
      })
      .executeTest(async (mock) => {
        const res = await postRequest(mock.url);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { slot: string; status: string };
        expect(body.slot).toBe('email1');
        expect(body.status).toBe('PENDING');
      });
  });

  it('returns 403 VERIFICATION_CONSENT_REQUIRED when consent is not granted', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a live talent record with consent NOT granted')
      .uponReceiving('a verify request refused for missing consent')
      .withRequest('POST', `/v1/talent-records/${TALENT_ID}/email-verifications`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody({ slot: 'email1' });
      })
      .willRespondWith(403, (b) => {
        b.jsonBody(errorBody('VERIFICATION_CONSENT_REQUIRED', 'consent required to send a verification email'));
      })
      .executeTest(async (mock) => {
        const res = await postRequest(mock.url);
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('VERIFICATION_CONSENT_REQUIRED');
      });
  });

  it('returns 503 INTELLIGENCE_UNAVAILABLE when Talent Intelligence is not enabled', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a live talent record with consent granted but Talent Intelligence not enabled')
      .uponReceiving('a verify request while Talent Intelligence is not enabled')
      .withRequest('POST', `/v1/talent-records/${TALENT_ID}/email-verifications`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody({ slot: 'email1' });
      })
      .willRespondWith(503, (b) => {
        b.jsonBody({
          error: {
            code: 'INTELLIGENCE_UNAVAILABLE',
            message: like('Talent Intelligence is not enabled for this workspace'),
            request_id: uuid(),
            details: { intelligence_status: 'NOT_ENTITLED' },
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await postRequest(mock.url);
        expect(res.status).toBe(503);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('INTELLIGENCE_UNAVAILABLE');
      });
  });
});

describe('ats-web → GET /v1/talent-records/:id/email-verifications', () => {
  it('returns 200 the per-slot verification status', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a live talent record with a pending email verification')
      .uponReceiving('a per-slot email verification status read')
      .withRequest('GET', `/v1/talent-records/${TALENT_ID}/email-verifications`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          intelligence_status: 'ENABLED',
          items: [
            {
              slot: 'email1',
              value_present: true,
              status: 'pending',
              expires_at: regex(ISO_TIMESTAMP, '2026-07-10T00:10:00.000Z'),
            },
            { slot: 'email2', value_present: false, status: 'none', expires_at: null },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-records/${TALENT_ID}/email-verifications`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: Array<{ slot: string; status: string }> };
        expect(body.items[0]!.status).toBe('pending');
      });
  });
});

describe('ats-web → POST /v1/email-verifications/confirm (public)', () => {
  async function confirm(url: string, verification_id: string, code: string): Promise<Response> {
    return fetch(`${url}/v1/email-verifications/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verification_id, code }),
    });
  }

  it('returns 200 VERIFIED for the right code (no Cookie)', async () => {
    await provider
      .addInteraction()
      .given('a pending email verification exists in Talent Intelligence')
      .uponReceiving('a public confirm with the right one-time code')
      .withRequest('POST', '/v1/email-verifications/confirm', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({ verification_id: VERIFICATION_ID, code: '123456' });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ status: 'VERIFIED' });
      })
      .executeTest(async (mock) => {
        const res = await confirm(mock.url, VERIFICATION_ID, '123456');
        expect(res.status).toBe(200);
        expect(((await res.json()) as { status: string }).status).toBe('VERIFIED');
      });
  });

  it('returns 422 IDENTIFIER_VERIFICATION_REFUSED for a wrong code', async () => {
    await provider
      .addInteraction()
      .given('a pending email verification exists in Talent Intelligence')
      .uponReceiving('a public confirm with a wrong one-time code')
      .withRequest('POST', '/v1/email-verifications/confirm', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({ verification_id: VERIFICATION_ID, code: '000000' });
      })
      .willRespondWith(422, (b) => {
        b.jsonBody({
          error: {
            code: 'IDENTIFIER_VERIFICATION_REFUSED',
            message: like('invalid code'),
            request_id: uuid(),
            details: { reason: 'INVALID_CODE', attempts_remaining: like(4) },
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await confirm(mock.url, VERIFICATION_ID, '000000');
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('IDENTIFIER_VERIFICATION_REFUSED');
      });
  });

  it('returns 404 NOT_FOUND for an unknown verification (uniform, no Cookie)', async () => {
    await provider
      .addInteraction()
      .given('no matching email verification exists')
      .uponReceiving('a public confirm for an unknown verification')
      .withRequest('POST', '/v1/email-verifications/confirm', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({
          verification_id: UNKNOWN_VERIFICATION_ID,
          code: '123456',
        });
      })
      .willRespondWith(404, (b) => {
        b.jsonBody(errorBody('NOT_FOUND', 'not found'));
      })
      .executeTest(async (mock) => {
        const res = await confirm(mock.url, UNKNOWN_VERIFICATION_ID, '123456');
        expect(res.status).toBe(404);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
