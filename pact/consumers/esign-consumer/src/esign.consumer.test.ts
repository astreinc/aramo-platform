import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { like, uuid } = MatchersV3;

// DOC-3 — cross-service E-Sign provider contract.
//
// Consumer:  aramo-core        (apps/api, via EsignServiceHttpProvider — the
//                               SignatureProviderPort HTTP adapter)
// Provider:  esign-service     (apps/esign-service)
//
// This is the TRANSPORT contract Documents (in apps/api) invokes to drive
// signature execution — provider-neutral (libs/documents-contracts). apps/api
// reaches E-Sign ONLY over HTTP through this seam; it never touches the esign
// schema. RTR/Offer (DOC-5/6) consume this already-complete seam.
//
// Coverage: the request/response contract shape of the provider surface —
//   1. POST /v1/esign/envelopes                    201 EnvelopeSummary (fresh)
//   2. GET  /v1/esign/envelopes/{id}               200 EnvelopeSummary
//   3. GET  /v1/esign/envelopes/{id}/evidence      200 EvidenceSummary

const provider = new PactV4({
  consumer: 'aramo-core',
  provider: 'esign-service',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const ENVELOPE_ID = '22222222-2222-7222-8222-222222222222';
const SIGNER_ID = '33333333-3333-7333-8333-333333333333';
const CREATED_BY = '44444444-4444-7444-8444-444444444444';
const DOC_REF = '55555555-5555-7555-8555-555555555555';
const REV_REF = '66666666-6666-7666-8666-666666666666';
const SHA256 = 'a'.repeat(64);

describe('aramo-core → POST /v1/esign/envelopes', () => {
  it('returns 201 EnvelopeSummary for a fresh envelope', async () => {
    await provider
      .addInteraction()
      .given('no prior envelope for the request')
      .uponReceiving('a create-envelope request from the Documents provider adapter')
      .withRequest('POST', '/v1/esign/envelopes', (b) => {
        b.headers({ 'Content-Type': 'application/json' }).jsonBody({
          tenant_id: TENANT_ID,
          subject: 'Offer Letter',
          execution_mode: 'SINGLE_SIGNATURE',
          created_by: CREATED_BY,
          documents: [
            {
              document_ref: DOC_REF,
              document_revision_ref: REV_REF,
              title: 'offer.pdf',
              source_sha256: SHA256,
              ordinal: 1,
            },
          ],
          signers: [{ email: 'jane@example.com', name: 'Jane Doe', signing_order: 1 }],
        });
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          envelope_id: uuid(ENVELOPE_ID),
          status: like('DRAFT'),
          signers: [{ signer_id: uuid(SIGNER_ID), email: like('jane@example.com'), status: like('PENDING') }],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/esign/envelopes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenant_id: TENANT_ID,
            subject: 'Offer Letter',
            execution_mode: 'SINGLE_SIGNATURE',
            created_by: CREATED_BY,
            documents: [
              { document_ref: DOC_REF, document_revision_ref: REV_REF, title: 'offer.pdf', source_sha256: SHA256, ordinal: 1 },
            ],
            signers: [{ email: 'jane@example.com', name: 'Jane Doe', signing_order: 1 }],
          }),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { envelope_id: string; status: string };
        expect(body.status).toBe('DRAFT');
      });
  });
});

describe('aramo-core → GET /v1/esign/envelopes/{id}', () => {
  it('returns 200 EnvelopeSummary for an existing envelope', async () => {
    await provider
      .addInteraction()
      .given('a signature envelope exists')
      .uponReceiving('a get-envelope request')
      .withRequest('GET', `/v1/esign/envelopes/${ENVELOPE_ID}`, (b) => {
        b.query({ tenant_id: TENANT_ID });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          envelope_id: uuid(ENVELOPE_ID),
          status: like('DRAFT'),
          signers: [{ signer_id: uuid(SIGNER_ID), email: like('jane@example.com'), status: like('PENDING') }],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/esign/envelopes/${ENVELOPE_ID}?tenant_id=${TENANT_ID}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { envelope_id: string };
        expect(body.envelope_id).toBe(ENVELOPE_ID);
      });
  });
});

describe('aramo-core → GET /v1/esign/envelopes/{id}/evidence', () => {
  it('returns 200 EvidenceSummary with an event-chain hash + software signature', async () => {
    await provider
      .addInteraction()
      .given('a signature envelope exists')
      .uponReceiving('a get-evidence request')
      .withRequest('GET', `/v1/esign/envelopes/${ENVELOPE_ID}/evidence`, (b) => {
        b.query({ tenant_id: TENANT_ID });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          envelope_id: uuid(ENVELOPE_ID),
          status: like('DRAFT'),
          event_chain_hash: like('QmV2ZW50Q2hhaW5IYXNo'),
          signature: like('c2lnbmF0dXJl'),
          signature_algorithm: like('SHA256-SOFTWARE-DOC3'),
          completed_at: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/esign/envelopes/${ENVELOPE_ID}/evidence?tenant_id=${TENANT_ID}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { envelope_id: string; signature_algorithm: string };
        expect(body.envelope_id).toBe(ENVELOPE_ID);
      });
  });
});

// DOC-4C (R1 seam B) — the executed-artifact PULL apps/api performs after
// completion (EsignExecutedArtifactsClient, apps/api/src/documents/esign-writeback.ts
// → GET /v1/esign/envelopes/:id/executed). A NEW INTERACTION on the SAME
// aramo-core → esign-service relationship (not a new consumer identity).
describe('aramo-core → GET /v1/esign/envelopes/{id}/executed', () => {
  // A DISTINCT COMPLETED envelope (the 'a signature envelope exists' fixture is a
  // DRAFT with no executed artifacts, and SignatureEvent is append-only so it
  // cannot be re-seeded onto the same id).
  const EXEC_ENVELOPE_ID = '88888888-8888-7888-8888-888888888888';
  const EXEC_ENV_DOC_ID = '99999999-9999-7999-8999-999999999999';
  it('returns 200 ExecutedArtifactsBundle (executed documents + certificate, base64)', async () => {
    await provider
      .addInteraction()
      .given('an executed envelope exists')
      .uponReceiving('an executed-artifact pull for the Documents write-back')
      .withRequest('GET', `/v1/esign/envelopes/${EXEC_ENVELOPE_ID}/executed`, (b) => {
        b.query({ tenant_id: TENANT_ID });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          envelope_id: uuid(EXEC_ENVELOPE_ID),
          documents: [
            {
              envelope_document_id: uuid(EXEC_ENV_DOC_ID),
              document_ref: uuid(DOC_REF),
              document_revision_ref: uuid(REV_REF),
              executed_sha256: like('b'.repeat(64)),
              byte_size: like(12),
              executed_base64: like('JVBERi0xLjQ='),
            },
          ],
          certificate: {
            certificate_sha256: like('c'.repeat(64)),
            byte_size: like(10),
            certificate_base64: like('Y2VydA=='),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/esign/envelopes/${EXEC_ENVELOPE_ID}/executed?tenant_id=${TENANT_ID}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { envelope_id: string; documents: unknown[]; certificate: unknown };
        expect(body.envelope_id).toBe(EXEC_ENVELOPE_ID);
        expect(Array.isArray(body.documents)).toBe(true);
        expect(body.certificate).not.toBeNull();
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
