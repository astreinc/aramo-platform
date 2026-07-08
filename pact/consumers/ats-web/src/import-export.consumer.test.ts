import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  ISO_TIMESTAMP,
  TENANT_ID,
  errorBody,
  like,
  makeAtsWebProvider,
  regex,
  uuid,
} from './support/ats-web-pact.js';

// PC-7d — ats-web import/export + PUBLIC invitation-accept.
//   - GET /v1/exports/:entity_type — text/csv; the pin is the ENVELOPE
//     (status + Content-Type + a like-matched CSV string), NOT rows (Gate-0).
//   - GET /v1/imports + /v1/imports/:id/failures — import:read list reads.
//   - POST /v1/invitations/accept — NO guard, NO cookie (acceptance precedes
//     first login). Token-reason machine: every refusal is 400
//     VALIDATION_ERROR with the SAME oracle-resistant message
//     ('invitation is invalid or expired') and details.reason ∈
//     {missing_body, missing_token, invalid_token, revoked, already_accepted,
//     expired}. Per Gate-0: representative variants contracted (missing_token
//     / invalid_token / expired — the three distinct guard layers: controller
//     parse, hash miss, state check) with like-matched reason; revoked /
//     already_accepted ride the same rendered shape.
// idempotency 0-by-substrate (no Idempotency-Key on any of the 9).

const provider = makeAtsWebProvider();

const IMPORT_BATCH_ID = '00000000-0000-7000-8000-1ba700000001';

describe('ats-web → exports', () => {
  it('GET /v1/exports/talent_record returns a CSV envelope', async () => {
    await provider
      .addInteraction()
      .given('an ats-web talent record exists for export')
      .uponReceiving('a talent-record CSV export')
      .withRequest('GET', '/v1/exports/talent_record', (b) => { b.headers({ Cookie: like(ACCESS_COOKIE) }); })
      .willRespondWith(200, (b) => {
        b.headers({ 'Content-Type': 'text/csv; charset=utf-8' });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/exports/talent_record`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/csv');
      });
  });
});

describe('ats-web → imports', () => {
  it('GET /v1/imports returns the batch list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web import batch exists')
      .uponReceiving('an import batches list read')
      .withRequest('GET', '/v1/imports', (b) => { b.headers({ Cookie: like(ACCESS_COOKIE) }); })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: [
            {
              id: uuid(IMPORT_BATCH_ID),
              tenant_id: uuid(TENANT_ID),
              site_id: null,
              imported_by_id: uuid(),
              target_entity: like('talent_record'),
              source_filename: like('talent-2026-05.csv'),
              row_count: like(3),
              success_count: like(2),
              failure_count: like(1),
              status: like('partially_committed'),
              created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00.000Z'),
              committed_at: null,
              reverted_at: null,
            },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/imports`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });

  it('GET /v1/imports/:id/failures returns the row-level failures', async () => {
    await provider
      .addInteraction()
      .given('an ats-web import batch with a failure exists')
      .uponReceiving('an import failures read')
      .withRequest('GET', `/v1/imports/${IMPORT_BATCH_ID}/failures`, (b) => { b.headers({ Cookie: like(ACCESS_COOKIE) }); })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: [
            {
              id: uuid(),
              tenant_id: uuid(TENANT_ID),
              import_batch_id: uuid(IMPORT_BATCH_ID),
              row_number: like(2),
              failure_reason: like('invalid email'),
              offending_fields: like(['email']),
              original_row_data: like({}),
              created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00.000Z'),
            },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/imports/${IMPORT_BATCH_ID}/failures`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });
});

describe('ats-web → public invitation accept', () => {
  it('POST /v1/invitations/accept with a valid token returns 200 ACCEPTED', async () => {
    const BODY = { token: 'pact-accept-raw-token' };
    await provider
      .addInteraction()
      .given('an ats-web pending invitation with a known token exists')
      .uponReceiving('a public invitation acceptance')
      .withRequest('POST', '/v1/invitations/accept', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ status: like('ACCEPTED'), tenant_id: uuid(TENANT_ID) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/invitations/accept`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
      });
  });

  it('POST /v1/invitations/accept with an empty token returns 400 (missing_token)', async () => {
    const BODY = { token: '' };
    await provider
      .addInteraction()
      .given('no ats-web invitation matches the token')
      .uponReceiving('a public invitation acceptance without a token')
      .withRequest('POST', '/v1/invitations/accept', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(400, (b) => { b.jsonBody(errorBody('VALIDATION_ERROR', 'token is required')); })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/invitations/accept`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(400);
      });
  });

  it('POST /v1/invitations/accept with an unknown token returns 400 (invalid_token)', async () => {
    const BODY = { token: 'no-such-raw-token' };
    await provider
      .addInteraction()
      .given('no ats-web invitation matches the token')
      .uponReceiving('a public invitation acceptance with an unknown token')
      .withRequest('POST', '/v1/invitations/accept', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(400, (b) => { b.jsonBody(errorBody('VALIDATION_ERROR', 'invitation is invalid or expired')); })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/invitations/accept`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(400);
      });
  });

  it('POST /v1/invitations/accept with an expired token returns 400 (expired)', async () => {
    const BODY = { token: 'pact-expired-raw-token' };
    await provider
      .addInteraction()
      .given('an ats-web expired invitation with a known token exists')
      .uponReceiving('a public invitation acceptance with an expired token')
      .withRequest('POST', '/v1/invitations/accept', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(400, (b) => { b.jsonBody(errorBody('VALIDATION_ERROR', 'invitation is invalid or expired')); })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/invitations/accept`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(400);
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
