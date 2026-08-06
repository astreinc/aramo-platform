import { describe, expect, it } from 'vitest';

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

// E1-d — Pact consumer for ats-web, placement domain (the FIRST real consumer
// of the /v1/placements read surface). Merges into ats-web-aramo-core.json.
// The request shapes mirror apps/ats-web/src/placement/placement-api.ts exactly
// (listPlacements / getPlacement / listPlacementEvents), Cookie-authenticated
// like every ats-web read; the provider requestFilter rewrites the fake cookie
// to a real placement:read + ats JWT.
//
// Contract intent:
//   - collection + item responses carry NO reason evidence (D-1/D-2 pinned at
//     the wire: no reason_* keys on PlacementProcess);
//   - the event timeline is the ONLY surface with reason_* — a governed event
//     carries canonical code+label(+detail), a legacy event carries nulls;
//   - not-found is 404 with the locked error envelope.
// Authorization-refusal interactions are omitted by ruling (the client always
// sends its authorized cookie; scope/capability refusals are covered by the
// apps/api HTTP integration spec, not the contract) — matches the requisition
// consumer precedent.

const provider = makeAtsWebProvider();

const PLACEMENT_ID = '00000000-0000-7000-8000-9ace00000001';
const REQ_ID = '00000000-0000-7000-8000-4e9000000001';
const SUBMITTAL_ID = '00000000-0000-7000-8000-50b000000001';
const TALENT_ID_P = '00000000-0000-7000-8000-7a1e00000001';
const EVENT_GOVERNED_ID = '00000000-0000-7000-8000-e0e000000001';
const EVENT_LEGACY_ID = '00000000-0000-7000-8000-e0e000000002';

// Faithful PlacementProcessView — NO reason fields exist on this surface.
function placementView(id: string = PLACEMENT_ID) {
  return {
    id: uuid(id),
    tenant_id: uuid(TENANT_ID),
    submittal_id: uuid(SUBMITTAL_ID),
    requisition_id: uuid(REQ_ID),
    talent_record_id: uuid(TALENT_ID_P),
    state: like('OFFER_EXTENDED'),
    offered_at: regex(ISO_TIMESTAMP, '2026-08-01T00:00:00Z'),
    proposed_start_date: null,
    offer_expires_at: null,
    client_offer_reference: null,
    offer_terms_summary: null,
    created_at: regex(ISO_TIMESTAMP, '2026-08-01T00:00:00Z'),
  };
}

// A governed-terminal event carries canonical reason evidence (the authorized
// detail surface); a legacy/non-governed event carries nulls.
function governedEvent() {
  return {
    id: uuid(EVENT_GOVERNED_ID),
    tenant_id: uuid(TENANT_ID),
    placement_process_id: uuid(PLACEMENT_ID),
    event_type: like('state_transition'),
    event_payload: like({ from: 'OFFER_EXTENDED', to: 'OFFER_DECLINED' }),
    reason_code: like('other'),
    reason_label_snapshot: like('Other'),
    reason_detail: like('operational note'),
    created_at: regex(ISO_TIMESTAMP, '2026-08-02T00:00:00Z'),
  };
}
function legacyEvent() {
  return {
    id: uuid(EVENT_LEGACY_ID),
    tenant_id: uuid(TENANT_ID),
    placement_process_id: uuid(PLACEMENT_ID),
    event_type: like('state_transition'),
    event_payload: like({ from: 'OFFER_EXTENDED', to: 'OFFER_ACCEPTED' }),
    reason_code: null,
    reason_label_snapshot: null,
    reason_detail: null,
    created_at: regex(ISO_TIMESTAMP, '2026-08-01T12:00:00Z'),
  };
}

describe('ats-web → GET /v1/placements (collection)', () => {
  it('returns 200 with the placement list (no reason evidence on items)', async () => {
    await provider
      .addInteraction()
      .given('an ats-web reader and a placement exist')
      .uponReceiving('a placements collection read')
      .withRequest('GET', '/v1/placements', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: [placementView()] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/placements`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: Array<Record<string, unknown>> };
        expect(body.items.length).toBeGreaterThan(0);
        // The client relies on reason evidence being ABSENT from collection items.
        for (const item of body.items) {
          expect(item).not.toHaveProperty('reason_code');
          expect(item).not.toHaveProperty('reason_label_snapshot');
          expect(item).not.toHaveProperty('reason_detail');
        }
      });
  });

  it('returns 200 with an empty list when the tenant has no placements', async () => {
    await provider
      .addInteraction()
      .given('an ats-web reader and no placements exist')
      .uponReceiving('a placements collection read (empty)')
      .withRequest('GET', '/v1/placements', (b) => {
        b.query({ requisition_id: uuid(REQ_ID) });
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: [] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/placements?requisition_id=${REQ_ID}`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items).toEqual([]);
      });
  });
});

describe('ats-web → GET /v1/placements/:id', () => {
  it('returns 200 with the placement (no reason evidence)', async () => {
    await provider
      .addInteraction()
      .given('an ats-web reader and a placement exist')
      .uponReceiving('a placement detail read')
      .withRequest('GET', `/v1/placements/${PLACEMENT_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(placementView());
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/placements/${PLACEMENT_ID}`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.id).toBe(PLACEMENT_ID);
        expect(body).not.toHaveProperty('reason_code');
      });
  });

  it('returns 404 with the locked error envelope for an unknown placement', async () => {
    const missing = '00000000-0000-7000-8000-000000000404';
    await provider
      .addInteraction()
      .given('an ats-web reader and no placement exists for the requested id')
      .uponReceiving('a placement detail read for an unknown id')
      .withRequest('GET', `/v1/placements/${missing}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(404, (b) => {
        b.jsonBody(errorBody('NOT_FOUND', 'PlacementProcess not found in tenant (or not visible to actor)'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/placements/${missing}`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('NOT_FOUND');
      });
  });
});

describe('ats-web → GET /v1/placements/:id/events', () => {
  it('returns 200 with the event timeline (canonical reason + legacy null)', async () => {
    await provider
      .addInteraction()
      .given('an ats-web reader and a placement with a governed-terminal and a legacy event exist')
      .uponReceiving('a placement event timeline read')
      .withRequest('GET', `/v1/placements/${PLACEMENT_ID}/events`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: [legacyEvent(), governedEvent()] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/placements/${PLACEMENT_ID}/events`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: Array<{ reason_code: string | null }> };
        // The timeline carries both a null-reason legacy event and a canonical one.
        expect(body.items.some((e) => e.reason_code === null)).toBe(true);
        expect(body.items.some((e) => e.reason_code !== null)).toBe(true);
      });
  });
});
