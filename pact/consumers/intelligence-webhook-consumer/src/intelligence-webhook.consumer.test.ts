import { resolve } from 'node:path';

import { MatchersV3, PactV4 } from '@pact-foundation/pact';
import {
  EVENT_VERSION,
  GOLDEN_TALENT_PROFILE_UPDATED,
  INTELLIGENCE_WEBHOOK_SIGNATURE_HEADER,
  INTELLIGENCE_WEBHOOK_TIMESTAMP_HEADER,
  SOURCE_SYSTEM_ARAMO_ATS,
  signIntelligenceWebhook,
  type IntelligenceProfileUpdatedWebhook,
} from '@aramo/intelligence-contracts';
import { describe, expect, it } from 'vitest';

const { regex, like } = MatchersV3;

// ATI-SEP-1 T7/T8 (ADR-0036 §3 "TI → ATS") — Pact consumer for the Talent
// Intelligence webhook publisher (consumer `intelligence-webhook`) against the
// ATS receiver POST /v1/integrations/intelligence/events (provider aramo-core).
//
// The delivery is signed per libs/intelligence-contracts webhook-auth
// (aramo-intelligence-webhook-v1: HMAC-SHA256 base64 over scheme \n timestamp \n
// rawBody). A signature is time-bound (±300 s), so the pact records the marker
// PACT_VALID_SIGNATURE for the valid delivery and the provider verifier re-signs
// the exact forwarded bytes with a fresh timestamp (verify-api.ts requestFilter) —
// the STRICT production check is never relaxed. The bad-signature delivery keeps a
// bogus signature, so the receiver fails closed with 401.
//
// Interactions (2): a valid signed golden_talent.profile_updated → 202 recorded;
// the same delivery with a bad signature → 401. Ids + fact-type names only — no
// PII, no value.

const provider = new PactV4({
  consumer: 'intelligence-webhook',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

const PATH = '/v1/integrations/intelligence/events';
const PACT_VALID_SIGNATURE = 'pact-valid-signature';
const BOGUS_SIGNATURE = 'bm90LWEtdmFsaWQtc2lnbmF0dXJl';
const CONSUMER_TEST_SECRET = 'consumer-side-test-secret';

function delivery(eventId: string): IntelligenceProfileUpdatedWebhook {
  return {
    event_id: eventId,
    event_type: GOLDEN_TALENT_PROFILE_UPDATED,
    event_version: EVENT_VERSION,
    intelligence_subject_id: '00000000-0000-7000-8000-d05000000002',
    occurred_at: '2026-07-01T00:00:00.000Z',
    source_system_id: SOURCE_SYSTEM_ARAMO_ATS,
    source_tenant_id: '11111111-1111-7111-8111-111111111111',
    external_talent_id: '00000000-0000-7000-8000-d05000000001',
    changed_fact_types: ['CURRENT_EMPLOYER', 'TITLE'],
  };
}

describe('intelligence-webhook → POST /v1/integrations/intelligence/events', () => {
  it('returns 202 for a validly signed golden_talent.profile_updated delivery', async () => {
    const body = delivery('00000000-0000-7000-8000-e7e000000001');
    const rawBody = JSON.stringify(body);
    // The real signer the TI outbox drain uses (proves the header shape).
    const signed = signIntelligenceWebhook({ rawBody, secret: CONSUMER_TEST_SECRET, nowSec: Math.floor(Date.now() / 1000) });
    await provider
      .addInteraction()
      .given('the ATS accepts Talent Intelligence webhook deliveries')
      .uponReceiving('a validly signed golden_talent.profile_updated delivery')
      .withRequest('POST', PATH, (b) => {
        b.headers({
          'content-type': 'application/json',
          [INTELLIGENCE_WEBHOOK_TIMESTAMP_HEADER]: regex(/^\d{1,12}$/, '1782864000'),
          [INTELLIGENCE_WEBHOOK_SIGNATURE_HEADER]: regex(/^[A-Za-z0-9+/=-]+$/, PACT_VALID_SIGNATURE),
        }).jsonBody(body);
      })
      .willRespondWith(202, (b) => {
        b.jsonBody({ received: true, event_id: like(body.event_id) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...signed },
          body: rawBody,
        });
        expect(res.status).toBe(202);
        expect(((await res.json()) as { received: boolean }).received).toBe(true);
      });
  });

  it('returns 401 for a delivery with a bad signature (fail closed)', async () => {
    const body = delivery('00000000-0000-7000-8000-e7e000000002');
    await provider
      .addInteraction()
      .given('the ATS accepts Talent Intelligence webhook deliveries')
      .uponReceiving('a golden_talent.profile_updated delivery with a bad signature')
      .withRequest('POST', PATH, (b) => {
        b.headers({
          'content-type': 'application/json',
          [INTELLIGENCE_WEBHOOK_TIMESTAMP_HEADER]: regex(/^\d{1,12}$/, '1782864000'),
          [INTELLIGENCE_WEBHOOK_SIGNATURE_HEADER]: BOGUS_SIGNATURE,
        }).jsonBody(body);
      })
      .willRespondWith(401)
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${PATH}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [INTELLIGENCE_WEBHOOK_TIMESTAMP_HEADER]: String(Math.floor(Date.now() / 1000)),
            [INTELLIGENCE_WEBHOOK_SIGNATURE_HEADER]: BOGUS_SIGNATURE,
          },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(401);
      });
  });
});
