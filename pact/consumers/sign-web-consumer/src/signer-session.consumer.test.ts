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
// Provider:  esign-service   (apps/esign-service, EsignSignerController at
//                             `v1/esign/signing`).
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
//   1. POST /v1/esign/signing/exchange              200 { session_id, envelope_id, signer_id }
//   2. POST /v1/esign/signing/disclosure            200 { accepted: true }
//   3. POST /v1/esign/signing/fields/{id}/fill      200 { filled: true }
//   4. POST /v1/esign/signing/complete              200 { envelope_status }
//   5. POST /v1/esign/signing/disclosure-text       200 { disclosure_version, text, text_sha256 }  (Aramo Sign launch, A-7)
//   6. POST /v1/esign/signing/executed              200 { subject, completed_at, documents[], certificate_base64 }  (signer's signed copy)

const provider = new PactV4({
  consumer: 'sign-web',
  provider: 'esign-service',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

// Fixed values — MUST match the per-op seeds in pact/provider/src/verify-esign.ts.
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

describe('sign-web → POST /v1/esign/signing/exchange', () => {
  it('exchanges a capability token for a signer session', async () => {
    await provider
      .addInteraction()
      .given('a signer session is issued for the envelope')
      .uponReceiving('a token exchange from the Sign Web client')
      .withRequest('POST', '/v1/esign/signing/exchange', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({ token: TOKEN_EXCHANGE });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ session_id: uuid(EX_SESSION_ID), envelope_id: uuid(EX_ENVELOPE_ID), signer_id: uuid(EX_SIGNER_ID) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/esign/signing/exchange`, {
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

describe('sign-web → POST /v1/esign/signing/disclosure', () => {
  it('records the signer disclosure acceptance', async () => {
    await provider
      .addInteraction()
      .given('a signer session is ready to accept disclosure')
      .uponReceiving('a disclosure acceptance from the Sign Web client')
      .withRequest('POST', '/v1/esign/signing/disclosure', (b) => {
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
        const res = await fetch(`${mock.url}/v1/esign/signing/disclosure`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: TOKEN_DISCLOSURE, disclosure_version: 'v1', disclosure_text_hash: DISCLOSURE_V1_SHA256 }),
        });
        expect(res.status).toBe(200);
      });
  });
});

describe('sign-web → POST /v1/esign/signing/fields/{id}/fill', () => {
  it('fills a signature field', async () => {
    await provider
      .addInteraction()
      .given('a signer session has accepted disclosure with a fillable field')
      .uponReceiving('a field fill from the Sign Web client')
      .withRequest('POST', `/v1/esign/signing/fields/${FILL_FIELD_ID}/fill`, (b) => {
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
        const res = await fetch(`${mock.url}/v1/esign/signing/fields/${FILL_FIELD_ID}/fill`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: TOKEN_FILL, value: 'Jane Doe', signature_method: 'TYPED' }),
        });
        expect(res.status).toBe(200);
      });
  });
});

describe('sign-web → POST /v1/esign/signing/complete', () => {
  it('completes the signer and returns the derived envelope status', async () => {
    await provider
      .addInteraction()
      .given('a signer session is ready to complete with another pending signer')
      .uponReceiving('a completion from the Sign Web client')
      .withRequest('POST', '/v1/esign/signing/complete', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({ token: TOKEN_COMPLETE });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ envelope_status: like('IN_PROGRESS') });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/esign/signing/complete`, {
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

describe('sign-web → POST /v1/esign/signing/disclosure-text', () => {
  it('returns the current server-held disclosure', async () => {
    await provider
      .addInteraction()
      .given('a signer session is open on a signable envelope')
      .uponReceiving('a disclosure text read from the Sign Web client')
      .withRequest('POST', '/v1/esign/signing/disclosure-text', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({ token: TOKEN_DISCLOSURE_TEXT });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ disclosure_version: like('v1'), text: like(DISCLOSURE_V1_TEXT), text_sha256: like(DISCLOSURE_V1_SHA256) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/esign/signing/disclosure-text`, {
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

describe('sign-web → POST /v1/esign/signing/executed', () => {
  it("returns the signer's signed copy for a valid access link", async () => {
    await provider
      .addInteraction()
      .given('a signer has a signed-copy access link for a completed envelope')
      .uponReceiving('a signed-copy download from the Sign Web client')
      .withRequest('POST', '/v1/esign/signing/executed', (b) => {
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
        const res = await fetch(`${mock.url}/v1/esign/signing/executed`, {
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
