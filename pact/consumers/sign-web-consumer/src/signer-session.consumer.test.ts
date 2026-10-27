import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { like, uuid } = MatchersV3;

// DOC-4C (R1 seam A) — the public signer-session transport contract.
//
// Consumer:  sign-web        (apps/sign-web/src/sign-api.ts — the browser client
//                             the Talent uses to sign; tenant is resolved
//                             server-side FROM the capability token, never sent).
// Provider:  sign-service   (apps/sign-service, EsignSignerController at
//                             `v1/sign/signing`).
//
// Mirrors the EXACT operations sign-api.ts consumes (method / path / body). Per
// the established harness convention (esign.consumer.test.ts) the interactions
// are issued as raw fetches matching the client — the production client uses
// relative paths and is not import-invokable against the mock. `decline`
// (esign-http.controller.ts:187) is OMITTED (DOC-4C-R2 — sign-api.ts never
// calls it).
//
// Each op carries a DISTINCT capability token so the provider seeds an
// INDEPENDENT signer-session fixture per interaction — SignatureEvent is
// append-only (no delete), so shared-envelope re-seeding is impossible.
//
// Coverage (sign-api.ts:31-44):
//   1. POST /v1/sign/signing/exchange              200 { session_id, envelope_id, signer_id }
//   2. POST /v1/sign/signing/disclosure            200 { accepted: true }
//   3. POST /v1/sign/signing/fields/{id}/fill      200 { filled: true }
//   4. POST /v1/sign/signing/complete              200 { envelope_status }
//   5. POST /v1/sign/signing/disclosure-text       200 { disclosure_version, text, text_sha256 }  (Aramo Sign launch, A-7)
//   6. POST /v1/sign/signing/executed              200 { subject, completed_at, documents[], certificate_base64 }  (signer's signed copy)
//   7. POST /v1/sign/signing/fields/{id}/fill      200 — a check box unchecked with 'false' (M-A6 §2.3)
//   8. POST /v1/sign/signing/document              200 — field configuration + the server-filled name (M-A6 §2.4)

const provider = new PactV4({
  consumer: 'sign-web',
  provider: 'sign-service',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

// Fixed values — MUST match the per-op seeds in pact/provider/src/verify-sign.ts.
const TOKEN_EXCHANGE = 'sign-web-pact-token-exchange';
const TOKEN_DISCLOSURE = 'sign-web-pact-token-disclosure';
const TOKEN_FILL = 'sign-web-pact-token-fill';
const TOKEN_COMPLETE = 'sign-web-pact-token-complete';
const TOKEN_DISCLOSURE_TEXT = 'sign-web-pact-token-disclosure-text';
const TOKEN_EXECUTED = 'sign-web-pact-token-executed';
// A-7 — the server-held v1 disclosure. Acceptance must echo its exact version + hash.
const DISCLOSURE_V1_TEXT = 'By continuing you consent to sign this document electronically.';
const DISCLOSURE_V1_SHA256 = createHash('sha256').update(DISCLOSURE_V1_TEXT, 'utf8').digest('hex');
// exchange is the only op that echoes ids in its response.
const EX_ENVELOPE_ID = '7a000000-0000-7000-8000-0000000000a1';
const EX_SIGNER_ID = '7a000000-0000-7000-8000-0000000000a2';
const EX_SESSION_ID = '7a000000-0000-7000-8000-0000000000a3';
const FILL_FIELD_ID = '7a000000-0000-7000-8000-0000000000c4';
// M-A6 §2 — uncheck a check box ('false'); the document view with the
// server-filled profile name and the check box configuration.
const TOKEN_UNCHECK = 'sign-web-pact-token-uncheck';
const UNCHECK_FIELD_ID = '7a000000-0000-7000-8000-000000000a04';
const TOKEN_VIEW = 'sign-web-pact-token-view';
const VIEW_NAME_FIELD_ID = '7a000000-0000-7000-8000-000000000b04';
const VIEW_BOX_FIELD_ID = '7a000000-0000-7000-8000-000000000b07';

describe('sign-web → POST /v1/sign/signing/exchange', () => {
  it('exchanges a capability token for a signer session', async () => {
    await provider
      .addInteraction()
      .given('a signer session is issued for the envelope')
      .uponReceiving('a token exchange from the Sign Web client')
      .withRequest('POST', '/v1/sign/signing/exchange', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({ token: TOKEN_EXCHANGE });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ session_id: uuid(EX_SESSION_ID), envelope_id: uuid(EX_ENVELOPE_ID), signer_id: uuid(EX_SIGNER_ID) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/signing/exchange`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: TOKEN_EXCHANGE }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { envelope_id: string };
        expect(body.envelope_id).toBe(EX_ENVELOPE_ID);
      });
  });
});

describe('sign-web → POST /v1/sign/signing/disclosure', () => {
  it('records the signer disclosure acceptance', async () => {
    await provider
      .addInteraction()
      .given('a signer session is ready to accept disclosure')
      .uponReceiving('a disclosure acceptance from the Sign Web client')
      .withRequest('POST', '/v1/sign/signing/disclosure', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({
          token: TOKEN_DISCLOSURE,
          disclosure_version: 'v1',
          disclosure_text_hash: DISCLOSURE_V1_SHA256,
        });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ accepted: like(true) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/signing/disclosure`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: TOKEN_DISCLOSURE, disclosure_version: 'v1', disclosure_text_hash: DISCLOSURE_V1_SHA256 }),
        });
        expect(res.status).toBe(200);
      });
  });
});

describe('sign-web → POST /v1/sign/signing/fields/{id}/fill', () => {
  it('fills a signature field', async () => {
    await provider
      .addInteraction()
      .given('a signer session has accepted disclosure with a fillable field')
      .uponReceiving('a field fill from the Sign Web client')
      .withRequest('POST', `/v1/sign/signing/fields/${FILL_FIELD_ID}/fill`, (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({
          token: TOKEN_FILL,
          value: 'Jane Doe',
          signature_method: 'TYPED',
        });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ filled: like(true) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/signing/fields/${FILL_FIELD_ID}/fill`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: TOKEN_FILL, value: 'Jane Doe', signature_method: 'TYPED' }),
        });
        expect(res.status).toBe(200);
      });
  });
});

describe('sign-web → POST /v1/sign/signing/complete', () => {
  it('completes the signer and returns the derived envelope status', async () => {
    await provider
      .addInteraction()
      .given('a signer session is ready to complete with another pending signer')
      .uponReceiving('a completion from the Sign Web client')
      .withRequest('POST', '/v1/sign/signing/complete', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({ token: TOKEN_COMPLETE });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ envelope_status: like('IN_PROGRESS') });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/signing/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: TOKEN_COMPLETE }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { envelope_status: string };
        expect(typeof body.envelope_status).toBe('string');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);

describe('sign-web → POST /v1/sign/signing/disclosure-text', () => {
  it('returns the current server-held disclosure', async () => {
    await provider
      .addInteraction()
      .given('a signer session is open on a signable envelope')
      .uponReceiving('a disclosure text read from the Sign Web client')
      .withRequest('POST', '/v1/sign/signing/disclosure-text', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({ token: TOKEN_DISCLOSURE_TEXT });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ disclosure_version: like('v1'), text: like(DISCLOSURE_V1_TEXT), text_sha256: like(DISCLOSURE_V1_SHA256) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/signing/disclosure-text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: TOKEN_DISCLOSURE_TEXT }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { text_sha256: string };
        expect(body.text_sha256).toMatch(/^[0-9a-f]{64}$/);
      });
  });
});

describe('sign-web → POST /v1/sign/signing/executed', () => {
  it("returns the signer's signed copy for a valid access link", async () => {
    await provider
      .addInteraction()
      .given('a signer has a signed-copy access link for a completed envelope')
      .uponReceiving('a signed-copy download from the Sign Web client')
      .withRequest('POST', '/v1/sign/signing/executed', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({ token: TOKEN_EXECUTED });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          subject: like('Offer Letter'),
          completed_at: like('2026-10-18T12:00:00.000Z'),
          documents: [{ title: like('offer.pdf'), content_type: like('application/pdf'), executed_base64: like('JVBERi0xLjQ=') }],
          certificate_base64: like('Y2VydA=='),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/signing/executed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: TOKEN_EXECUTED }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { documents: unknown[] };
        expect(body.documents.length).toBe(1);
      });
  });
});

describe('sign-web → POST /v1/sign/signing/fields/{id}/fill (M-A6 check box)', () => {
  it("unchecks a check box with 'false'", async () => {
    await provider
      .addInteraction()
      .given('a signer session has accepted disclosure with a check box')
      .uponReceiving('a check box uncheck from the Sign Web client')
      .withRequest('POST', `/v1/sign/signing/fields/${UNCHECK_FIELD_ID}/fill`, (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({ token: TOKEN_UNCHECK, value: 'false' });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ filled: like(true) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/signing/fields/${UNCHECK_FIELD_ID}/fill`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: TOKEN_UNCHECK, value: 'false' }),
        });
        expect(res.status).toBe(200);
      });
  });
});

describe('sign-web → POST /v1/sign/signing/document (M-A6 field configuration)', () => {
  it('returns the server-filled profile name and the check box configuration', async () => {
    await provider
      .addInteraction()
      .given('a signer session has accepted disclosure with a profile name and a check box')
      .uponReceiving('a document view with Name and Checkbox fields from the Sign Web client')
      .withRequest('POST', '/v1/sign/signing/document', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({ token: TOKEN_VIEW });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          documents: [{ document_id: uuid('7a000000-0000-7000-8000-000000000b06'), title: like('offer.pdf'), ordinal: like(1) }],
          fields: [
            {
              field_id: uuid(VIEW_NAME_FIELD_ID),
              field_type: 'SIGNER_NAME',
              required: true,
              filled: true,
              value: like('Jane Doe'),
              name_mode: 'SIGNER_PROFILE',
              server_filled: true,
            },
            {
              field_id: uuid(VIEW_BOX_FIELD_ID),
              field_type: 'CHECKBOX',
              required: true,
              filled: false,
              value: null,
              label: like('I agree to the terms'),
              group_key: null,
              group_rule: null,
              min_selected: null,
              name_mode: null,
              server_filled: false,
            },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sign/signing/document`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: TOKEN_VIEW }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { fields: { server_filled: boolean; value: string | null }[] };
        expect(body.fields[0]?.server_filled).toBe(true);
        expect(body.fields[0]?.value).toBe('Jane Doe');
      });
  });
});
