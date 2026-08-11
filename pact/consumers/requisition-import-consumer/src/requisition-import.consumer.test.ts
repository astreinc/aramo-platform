import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { like, uuid, regex } = MatchersV3;

// T8-P2 — requisition-import consumer Pact (VMS Integration Directive v1.0 §17).
//
// Consumer:  requisition-import-consumer  (the future T8-CONNECTOR / ingestion
//                                          adapter that produces canonical
//                                          requisition records and posts them)
// Provider:  aramo-core                   (apps/api)
//
// Scope: the provider-neutral canonical ingestion contract SHAPE —
//   POST /v1/requisition-imports  →  201 ImportBatchView
// Transport-neutral: the connector produces the canonical envelope regardless
// of poll/webhook/file/SFTP. No provider name, no credential in the contract.
//
// R10 faithful-display discipline: the response shape is restricted to the
// fields openapi/ats.yaml#ImportBatchView defines; no banned vocabulary appears.

const provider = new PactV4({
  consumer: 'requisition-import-consumer',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const BATCH_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const IMPORTER_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const REQUEST_ID = '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1aa0';
const ACCESS_COOKIE = 'aramo_access_token=eyJfake.access.token';
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

const REQUEST_BODY = {
  source_label: 'connector-batch-001',
  records: [
    {
      source_system: 'fieldglass',
      external_req_id: 'EXT-REQ-1',
      title: 'Senior Platform Engineer',
      openings: 2,
      company_id: '22222222-2222-7222-8222-222222222222',
    },
  ],
};

describe('requisition-import-consumer → POST /v1/requisition-imports', () => {
  it('returns 201 ImportBatchView for a committed canonical requisition import', async () => {
    await provider
      .addInteraction()
      .given(
        'a tenant entitled to ats with a caller holding requisition:import:write and no prior requisition for the external identity',
      )
      .uponReceiving('a canonical requisition import batch')
      .withRequest('POST', '/v1/requisition-imports', (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Content-Type': 'application/json',
        }).jsonBody(REQUEST_BODY);
      })
      .willRespondWith(201, (b) => {
        b.headers({ 'X-Request-ID': uuid(REQUEST_ID) }).jsonBody({
          id: uuid(BATCH_ID),
          tenant_id: uuid(TENANT_ID),
          site_id: null,
          imported_by_id: uuid(IMPORTER_ID),
          target_entity: 'requisition',
          source_filename: like('connector-batch-001'),
          row_count: like(1),
          success_count: like(1),
          failure_count: like(0),
          status: like('committed'),
          created_at: regex(ISO_TIMESTAMP, '2026-08-12T00:00:01Z'),
          committed_at: regex(ISO_TIMESTAMP, '2026-08-12T00:00:01Z'),
          reverted_at: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/requisition-imports`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(REQUEST_BODY),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { target_entity: string; status: string; success_count: number };
        expect(body.target_entity).toBe('requisition');
        expect(body.status).toBe('committed');
        expect(body.success_count).toBe(1);
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
