import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { like } = MatchersV3;

// DOC-4C (R1 seam C) — the source-document PULL esign-service performs against
// apps/api to produce executed documents.
//
// Consumer:  esign-service   (apps/esign-service, DocumentSourceHttpAdapter →
//                             GET /v1/documents/revisions/:id/source; E-Sign holds
//                             no DocumentStoragePort and never touches the
//                             documents schema — this authorized HTTP read is the
//                             only bytes path).
// Provider:  aramo-core      (apps/api, DocumentsEsignController).
//
// Mirrors the EXACT request DocumentSourceHttpAdapter.getSourcePdf issues: GET
// with a tenant_id query + the `X-Esign-Service` marker header; it reads only
// `source_base64` from the 200 body and treats any non-2xx as a failure.

const provider = new PactV4({
  consumer: 'esign-service',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const REVISION_ID = 'd0c4c000-0000-7000-8000-000000000001';
const MISSING_REVISION_ID = 'd0c4c000-0000-7000-8000-0000000000ff';

describe('esign-service → GET /v1/documents/revisions/{id}/source', () => {
  it('returns 200 with the base64 source bytes for a frozen revision', async () => {
    await provider
      .addInteraction()
      .given('a frozen document revision with a source artifact exists')
      .uponReceiving('a source-PDF pull from the E-Sign executed-document producer')
      .withRequest('GET', `/v1/documents/revisions/${REVISION_ID}/source`, (b) => {
        b.query({ tenant_id: TENANT_ID }).headers({ 'X-Esign-Service': '1' });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ revision_id: like(REVISION_ID), source_base64: like('JVBERi0xLjQ=') });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/documents/revisions/${REVISION_ID}/source?tenant_id=${TENANT_ID}`, {
          headers: { 'X-Esign-Service': '1' },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { source_base64: string };
        expect(typeof body.source_base64).toBe('string');
      });
  });

  it('returns 404 when the revision has no source artifact', async () => {
    await provider
      .addInteraction()
      .given('a document revision without a source artifact exists')
      .uponReceiving('a source-PDF pull for a revision with no source artifact')
      .withRequest('GET', `/v1/documents/revisions/${MISSING_REVISION_ID}/source`, (b) => {
        b.query({ tenant_id: TENANT_ID }).headers({ 'X-Esign-Service': '1' });
      })
      // The consumer (DocumentSourceHttpAdapter) only checks `!res.ok` — it never
      // reads the error body — so the contract is the 404 STATUS alone.
      .willRespondWith(404)
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/documents/revisions/${MISSING_REVISION_ID}/source?tenant_id=${TENANT_ID}`, {
          headers: { 'X-Esign-Service': '1' },
        });
        expect(res.status).toBe(404);
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
