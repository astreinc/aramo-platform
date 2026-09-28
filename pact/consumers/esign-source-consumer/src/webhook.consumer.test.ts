import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { like } = MatchersV3;

// E-Sign OC v2 (B8) — the CANONICAL E-Sign → Core lifecycle webhook contract.
//
// Consumer:  esign-service  (apps/esign-service HttpWebhookEventPublisher → POST
//                            /v1/integrations/esign/events, an HMAC+timestamp
//                            signed GENERIC lifecycle event).
// Provider:  aramo-core     (apps/api EsignEventsController).
//
// SCOPE (narrow, per the PO ruling): this proves the generic-receiver CONTRACT —
// path, method, required headers, generic payload SHAPE + version + identifiers,
// and that the provider ACKNOWLEDGES a valid generic event. It uses a
// NON-completion event so acceptance is self-contained (no write-back). The full
// completed→webhook→write-back→Document EXECUTED→RTR-readiness path is proven by
// the OC-6 E2E, NOT by this contract.
//
// The signature/timestamp headers are dynamic (like()): during provider
// verification the harness re-signs over the exact forwarded bytes with a FRESH
// timestamp (see pact/provider/src/verify-api.ts requestFilter) — so this contract
// never freezes a byte-exact signature, and production timestamp tolerance is NOT
// weakened. HMAC crypto semantics (accept/reject) are covered by the dedicated
// esign-webhook-signature unit tests.
//
// TEST-ONLY secret; matches the value the aramo-core provider re-signs with.
export const PACT_ESIGN_WEBHOOK_SECRET = 'pact-test-esign-webhook-secret';

const provider = new PactV4({
  consumer: 'esign-service',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const ENVELOPE_ID = 'e5190000-0000-7000-8000-000000000001';

const EVENT = {
  event_id: '0b0c0000-0000-7000-8000-000000000001',
  event_type: 'esign.envelope.sent.v1', // generic signing fact; non-completion → ack path
  event_version: 1,
  occurred_at: '2026-09-27T12:00:00.000Z',
  tenant_id: TENANT_ID,
  envelope_id: ENVELOPE_ID,
  correlation_id: 'c0000000-0000-7000-8000-000000000001',
  artifact_refs: { executed_document_ids: [], has_certificate: false },
};

describe('esign-service → POST /v1/integrations/esign/events', () => {
  it('acknowledges a valid, signed generic lifecycle event', async () => {
    await provider
      .addInteraction()
      .given('aramo-core can receive an E-Sign lifecycle webhook')
      .uponReceiving('a signed generic E-Sign lifecycle event from the platform delivery worker')
      .withRequest('POST', '/v1/integrations/esign/events', (b) => {
        // content-type is owned by jsonBody() below — do NOT also set it here (a
        // duplicate content-type breaks the pact proxy's bodyParser.json).
        b.headers({
          'x-aramo-esign-timestamp': like('1790000000'),
          'x-aramo-esign-signature': like('c2lnbmF0dXJl'),
        }).jsonBody({
          event_id: like(EVENT.event_id),
          event_type: 'esign.envelope.sent.v1',
          event_version: like(1),
          occurred_at: like(EVENT.occurred_at),
          tenant_id: like(TENANT_ID),
          envelope_id: like(ENVELOPE_ID),
          correlation_id: like(EVENT.correlation_id),
          artifact_refs: like({ executed_document_ids: [], has_certificate: false }),
        });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ received: like(true) });
      })
      .executeTest(async (mock) => {
        // The real publisher signs `${timestamp}.${rawBody}` and posts the raw body.
        const rawBody = JSON.stringify(EVENT);
        const ts = String(Math.floor(Date.now() / 1000));
        const sig = createHmac('sha256', PACT_ESIGN_WEBHOOK_SECRET).update(`${ts}.${rawBody}`).digest('base64');
        const res = await fetch(`${mock.url}/v1/integrations/esign/events`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-aramo-esign-timestamp': ts,
            'x-aramo-esign-signature': sig,
          },
          body: rawBody,
        });
        expect(res.status).toBe(200);
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
