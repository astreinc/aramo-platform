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
    state: like('PRE_START'),
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
    event_payload: like({ from: 'PRE_START', to: 'FELL_THROUGH' }),
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
    event_payload: like({ from: 'PRE_START', to: 'READY_TO_START' }),
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

// ===== Track 6 / T6-B2 — the governed commercial-revision surface =====
// Interaction shapes for the surface ats-web will consume (B4). Following the
// placement-read convention above, AUTHORIZATION refusals (403) are OMITTED here
// (the client always sends its authorized cookie; scope refusals are covered by the
// apps/api HTTP integration spec). The 409 window-conflict IS contracted (the client
// renders it). Response fields use TYPE matchers — the successor id + effective
// instant are server-generated, so exact values are never pinned.
const ASSIGNMENT_ID_B2 = '00000000-0000-7000-8000-ca0000000001';
const RATE_VERSION_ID_B2 = '00000000-0000-7000-8000-a1e000000001';
const RECORDED_BY_B2 = '00000000-0000-7000-8000-4ec000000001';

function commercialView(overrides: Record<string, unknown> = {}) {
  return {
    contract_assignment_id: uuid(ASSIGNMENT_ID_B2),
    assignment_rate_version_id: uuid(RATE_VERSION_ID_B2),
    requisition_id: uuid(REQ_ID),
    talent_record_id: uuid(TALENT_ID_P),
    pay_rate_amount: like('80.00'),
    bill_rate_amount: like('120.00'),
    currency: like('USD'),
    rate_period: like('HOURLY'),
    spread_amount: like('40.00'),
    margin_percent: like('33.33'),
    markup_percent: like('50.00'),
    effective_from: regex(ISO_TIMESTAMP, '2026-08-01T00:00:00Z'),
    effective_to: null,
    change_reason: like('rate correction'),
    recorded_by: uuid(RECORDED_BY_B2),
    created_at: regex(ISO_TIMESTAMP, '2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

const REVISION_REQUEST = {
  pay_rate_amount: '80.00',
  bill_rate_amount: '120.00',
  currency: 'USD',
  rate_period: 'HOURLY',
  // L7-B — effective_from is REQUIRED (deterministic revision identity).
  effective_from: '2030-01-01T00:00:00Z',
  change_reason: 'rate correction',
};

describe('ats-web → POST /v1/placements/:id/assignment/commercials/revisions', () => {
  it('returns 201 with the new current commercial version', async () => {
    await provider
      .addInteraction()
      .given('an ats-web writer and an active assignment with an open commercial version exist')
      .uponReceiving('a governed commercial revision')
      .withRequest('POST', `/v1/placements/${PLACEMENT_ID}/assignment/commercials/revisions`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
        b.jsonBody(REVISION_REQUEST);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({ commercials: commercialView() });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/placements/${PLACEMENT_ID}/assignment/commercials/revisions`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(REVISION_REQUEST),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { commercials: { effective_to: string | null } };
        expect(body.commercials.effective_to).toBeNull();
      });
  });

  it('returns 409 when the requested effective instant conflicts with an existing window', async () => {
    await provider
      .addInteraction()
      .given('an ats-web writer and an active assignment whose requested revision instant is already reserved')
      .uponReceiving('a commercial revision that conflicts with an existing effective window')
      .withRequest('POST', `/v1/placements/${PLACEMENT_ID}/assignment/commercials/revisions`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
        b.jsonBody({ ...REVISION_REQUEST, effective_from: '2030-01-01T00:00:00Z' });
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(errorBody('ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT', 'a commercial version already exists at this effective instant'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/placements/${PLACEMENT_ID}/assignment/commercials/revisions`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...REVISION_REQUEST, effective_from: '2030-01-01T00:00:00Z' }),
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT');
      });
  });
});

// Slice #4 — Commercial Approval. The core proposal path: propose the next
// commercial revision (INTENT). The provider actually creates the proposal
// against the seeded ACTIVE assignment + open version, so this verifies the new
// route, the documented CommercialProposalView shape (incl. the derived margin
// comparison), the migration-backed provider startup, and the writer scope.
const PROPOSAL_REQUEST = {
  pay_rate_amount: '90.00',
  bill_rate_amount: '150.00',
  currency: 'USD',
  rate_period: 'HOURLY',
  reason: 'rate uplift',
};

function marginSide(pay: string, bill: string, spread: string, margin: string, markup: string) {
  return {
    pay_rate_amount: like(pay),
    bill_rate_amount: like(bill),
    currency: like('USD'),
    rate_period: like('HOURLY'),
    spread_amount: like(spread),
    margin_percent: like(margin),
    markup_percent: like(markup),
  };
}

// A fresh DRAFT proposal: all per-transition evidence is null; ids are
// server-generated (format-matched); the margin comparison is derived on read.
function commercialProposalView() {
  return {
    id: uuid('00000000-0000-7000-8000-c0a000000001'),
    contract_assignment_id: uuid('00000000-0000-7000-8000-ca0000000001'),
    placement_process_id: uuid(PLACEMENT_ID),
    requisition_id: uuid(REQ_ID),
    talent_record_id: uuid(TALENT_ID_P),
    state: like('DRAFT'),
    proposed_pay_rate_amount: like('90.00'),
    proposed_bill_rate_amount: like('150.00'),
    proposed_currency: like('USD'),
    proposed_rate_period: like('HOURLY'),
    proposed_effective_from: null,
    reason: like('rate uplift'),
    requested_by: uuid('00000000-0000-7000-8000-4ec000000001'),
    margin: {
      current: marginSide('80.00', '120.00', '40.00', '33.33', '50.00'),
      proposed: marginSide('90.00', '150.00', '60.00', '40.00', '66.67'),
      pay_rate_delta: like('10.00'),
      bill_rate_delta: like('30.00'),
      margin_point_delta: like('6.67'),
    },
    review_decided_by: null,
    review_decided_at: null,
    review_note: null,
    client_approved_at: null,
    client_approval_recorded_by: null,
    client_reference: null,
    client_approval_source: null,
    client_approval_note: null,
    rejected_by: null,
    rejected_at: null,
    rejection_reason: null,
    applied_rate_version_id: null,
    applied_by: null,
    applied_at: null,
    created_at: regex(ISO_TIMESTAMP, '2026-08-01T00:00:00Z'),
  };
}

describe('ats-web → POST /v1/placements/:id/assignment/commercials/proposals', () => {
  it('returns 201 with the DRAFT proposal and its derived margin comparison', async () => {
    await provider
      .addInteraction()
      .given('an ats-web writer and an active assignment with an open commercial version exist')
      .uponReceiving('a commercial revision proposal')
      .withRequest('POST', `/v1/placements/${PLACEMENT_ID}/assignment/commercials/proposals`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
        b.jsonBody(PROPOSAL_REQUEST);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({ proposal: commercialProposalView() });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/placements/${PLACEMENT_ID}/assignment/commercials/proposals`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(PROPOSAL_REQUEST),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { proposal: { state: string; margin: { margin_point_delta: string } } };
        expect(body.proposal.state).toBe('DRAFT');
        expect(body.proposal.margin.margin_point_delta).toBe('6.67');
      });
  });
});

describe('ats-web → GET /v1/placements/:id/assignment/commercials/revisions', () => {
  it('returns 200 with a single current version', async () => {
    await provider
      .addInteraction()
      .given('an ats-web reader and an active assignment with an open commercial version exist')
      .uponReceiving('a commercial version-series read (current only)')
      .withRequest('GET', `/v1/placements/${PLACEMENT_ID}/assignment/commercials/revisions`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: [commercialView()] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/placements/${PLACEMENT_ID}/assignment/commercials/revisions`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items).toHaveLength(1);
      });
  });

  it('returns 200 with the current + historical series (effective_from DESC)', async () => {
    await provider
      .addInteraction()
      .given('an ats-web reader and an active assignment with a closed historical and an open current commercial version exist')
      .uponReceiving('a commercial version-series read (current + historical)')
      .withRequest('GET', `/v1/placements/${PLACEMENT_ID}/assignment/commercials/revisions`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: [
            commercialView(),
            commercialView({
              assignment_rate_version_id: uuid('00000000-0000-7000-8000-a1e000000002'),
              effective_to: regex(ISO_TIMESTAMP, '2026-08-01T00:00:00Z'),
            }),
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/placements/${PLACEMENT_ID}/assignment/commercials/revisions`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: Array<{ effective_to: string | null }> };
        expect(body.items).toHaveLength(2);
        expect(body.items[0].effective_to).toBeNull(); // current first (DESC)
      });
  });

  it('returns 200 with an empty series when the placement has no assignment', async () => {
    await provider
      .addInteraction()
      .given('an ats-web reader and a placement exist')
      .uponReceiving('a commercial version-series read for a placement with no assignment')
      .withRequest('GET', `/v1/placements/${PLACEMENT_ID}/assignment/commercials/revisions`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: [] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/placements/${PLACEMENT_ID}/assignment/commercials/revisions`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items).toHaveLength(0);
      });
  });

  it('returns 404 for a not-visible / unknown placement', async () => {
    const missing = '00000000-0000-7000-8000-000000000404';
    await provider
      .addInteraction()
      .given('an ats-web reader and no placement exists for the requested id')
      .uponReceiving('a commercial version-series read for an unknown placement')
      .withRequest('GET', `/v1/placements/${missing}/assignment/commercials/revisions`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(404, (b) => {
        b.jsonBody(errorBody('NOT_FOUND', 'PlacementProcess not found in tenant (or not visible to actor)'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/placements/${missing}/assignment/commercials/revisions`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('NOT_FOUND');
      });
  });
});

// ===== Track 6 / T6-B3 — governed cancellation of a FUTURE open-tail revision =====
// POST /v1/placements/:id/assignment/commercials/revisions/:revisionId/cancel → 200
// with the refreshed non-cancelled series. Per §24, four interactions are contracted:
// success, not-future/interior refusal, already-cancelled conflict, not-visible/unknown
// revision. The standard 403 is OMITTED (ats-web consumer convention). The 409s pin the
// ErrorCode only (details.reason is the machine discriminator; message is type-matched).
const CANCEL_FUTURE_REVISION_ID = '00000000-0000-7000-8000-a1e0000000c1';
const CANCEL_CURRENT_REVISION_ID = '00000000-0000-7000-8000-a1e0000000c2';
const CANCEL_UNKNOWN_REVISION_ID = '00000000-0000-7000-8000-a1e0000000cf';
const CANCEL_REQUEST = { cancellation_reason_code: 'SCHEDULE_WITHDRAWN' };

describe('ats-web → POST /v1/placements/:id/assignment/commercials/revisions/:revisionId/cancel', () => {
  it('returns 200 with the refreshed non-cancelled series after cancelling the future open tail', async () => {
    await provider
      .addInteraction()
      .given('an ats-web writer and an active assignment with a future open-tail commercial revision exist')
      .uponReceiving('a governed cancellation of a future open-tail commercial revision')
      .withRequest(
        'POST',
        `/v1/placements/${PLACEMENT_ID}/assignment/commercials/revisions/${CANCEL_FUTURE_REVISION_ID}/cancel`,
        (b) => {
          b.headers({ Cookie: like(ACCESS_COOKIE) });
          b.jsonBody(CANCEL_REQUEST);
        },
      )
      .willRespondWith(200, (b) => {
        // After cancellation the predecessor is re-opened, so the refreshed series is a
        // single open current version (effective_to null) and the cancelled tail is gone.
        b.jsonBody({ items: [commercialView()] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/placements/${PLACEMENT_ID}/assignment/commercials/revisions/${CANCEL_FUTURE_REVISION_ID}/cancel`,
          {
            method: 'POST',
            headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
            body: JSON.stringify(CANCEL_REQUEST),
          },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: Array<{ effective_to: string | null }> };
        expect(body.items[0].effective_to).toBeNull();
      });
  });

  it('returns 409 when the target revision is not a future open tail (current version)', async () => {
    await provider
      .addInteraction()
      .given('an ats-web writer and an active assignment whose current commercial version is not a future tail')
      .uponReceiving('a cancellation of a non-future (current) commercial version')
      .withRequest(
        'POST',
        `/v1/placements/${PLACEMENT_ID}/assignment/commercials/revisions/${CANCEL_CURRENT_REVISION_ID}/cancel`,
        (b) => {
          b.headers({ Cookie: like(ACCESS_COOKIE) });
          b.jsonBody(CANCEL_REQUEST);
        },
      )
      .willRespondWith(409, (b) => {
        b.jsonBody(errorBody('ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT', 'commercial revision conflict: revision_not_future'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/placements/${PLACEMENT_ID}/assignment/commercials/revisions/${CANCEL_CURRENT_REVISION_ID}/cancel`,
          {
            method: 'POST',
            headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
            body: JSON.stringify(CANCEL_REQUEST),
          },
        );
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT');
      });
  });

  it('returns 409 when the target revision is already cancelled', async () => {
    await provider
      .addInteraction()
      .given('an ats-web writer and an active assignment with an already-cancelled future commercial revision')
      .uponReceiving('a cancellation of an already-cancelled commercial revision')
      .withRequest(
        'POST',
        `/v1/placements/${PLACEMENT_ID}/assignment/commercials/revisions/${CANCEL_FUTURE_REVISION_ID}/cancel`,
        (b) => {
          b.headers({ Cookie: like(ACCESS_COOKIE) });
          b.jsonBody(CANCEL_REQUEST);
        },
      )
      .willRespondWith(409, (b) => {
        b.jsonBody(errorBody('ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT', 'commercial revision conflict: already_cancelled'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/placements/${PLACEMENT_ID}/assignment/commercials/revisions/${CANCEL_FUTURE_REVISION_ID}/cancel`,
          {
            method: 'POST',
            headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
            body: JSON.stringify(CANCEL_REQUEST),
          },
        );
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT');
      });
  });

  it('returns 404 for an unknown / not-visible revision', async () => {
    await provider
      .addInteraction()
      .given('an ats-web writer and an active assignment exist but the requested revision id is unknown')
      .uponReceiving('a cancellation of an unknown commercial revision')
      .withRequest(
        'POST',
        `/v1/placements/${PLACEMENT_ID}/assignment/commercials/revisions/${CANCEL_UNKNOWN_REVISION_ID}/cancel`,
        (b) => {
          b.headers({ Cookie: like(ACCESS_COOKIE) });
          b.jsonBody(CANCEL_REQUEST);
        },
      )
      .willRespondWith(404, (b) => {
        b.jsonBody(errorBody('NOT_FOUND', 'AssignmentRateVersion not found'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/placements/${PLACEMENT_ID}/assignment/commercials/revisions/${CANCEL_UNKNOWN_REVISION_ID}/cancel`,
          {
            method: 'POST',
            headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
            body: JSON.stringify(CANCEL_REQUEST),
          },
        );
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('NOT_FOUND');
      });
  });
});
