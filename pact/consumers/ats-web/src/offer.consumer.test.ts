import { describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  ISO_TIMESTAMP,
  TENANT_ID,
  like,
  makeAtsWebProvider,
  regex,
  uuid,
} from './support/ats-web-pact.js';

// Offer Lifecycle (D7 — LOCKED Aramo-Offer-D7-OfferPanel-Wiring v1.0) consumer
// pact for ats-web. Covers the NEW discovery route the OfferPanelContainer
// depends on: GET /v1/offers filtered by (requisition_id, talent_record_id).
// create (POST) + transition (PATCH) legality/shape are proven end-to-end by
// the libs/placement offer-repository integration (real Postgres); this pact
// pins the FE↔core contract for the new list surface through the real provider.

const provider = makeAtsWebProvider();

const OFFER_ID = '00000000-0000-7000-8000-0ffe00000001';
const OFFER_SUBMITTAL_ID = '00000000-0000-7000-8000-05b000000001';
const OFFER_REQ_ID = '00000000-0000-7000-8000-4e9200000001';
const OFFER_TALENT_ID = '00000000-0000-7000-8000-7a1e00000002';

function offerView(state: string) {
  return {
    id: uuid(OFFER_ID),
    tenant_id: uuid(TENANT_ID),
    submittal_id: uuid(OFFER_SUBMITTAL_ID),
    requisition_id: uuid(OFFER_REQ_ID),
    talent_record_id: uuid(OFFER_TALENT_ID),
    state: like(state),
    proposed_start_date: null,
    offer_expires_at: null,
    client_offer_reference: null,
    offer_terms_summary: null,
    decline_reason: null,
    created_at: regex(ISO_TIMESTAMP, '2026-08-01T00:00:00Z'),
  };
}

describe('ats-web → GET /v1/offers', () => {
  it('returns 200 with the offers list (D7 discovery)', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an offer exist')
      .uponReceiving('an offers list read by requisition + talent')
      .withRequest('GET', '/v1/offers', (b) => {
        b.query({
          requisition_id: OFFER_REQ_ID,
          talent_record_id: OFFER_TALENT_ID,
        }).headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: [offerView('DRAFT')] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/offers?requisition_id=${OFFER_REQ_ID}&talent_record_id=${OFFER_TALENT_ID}`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });
});
