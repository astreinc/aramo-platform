import { describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  TENANT_ID,
  errorBody,
  like,
  makeAtsWebProvider,
  uuid,
} from './support/ats-web-pact.js';

// Track 7 / T7-P5 — Pact consumer for ats-web, permanent-placement domain (the FIRST real
// consumer of the T7 permanent surface: the GET-permanent discriminator, the satisfy / falloff /
// remedy-complete lifecycle mutations, the reusable requisition-level guarantee terms, and the
// guarantee-exposure report). Merges into ats-web-aramo-core.json.
//
// The request shapes mirror the ats-web client modules EXACTLY:
//   - apps/ats-web/src/placement/permanent-placement-api.ts
//   - apps/ats-web/src/requisitions/guarantee-terms-api.ts
//   - apps/ats-web/src/reporting/guarantee-exposure-api.ts
// Cookie-authenticated like every ats-web request; the provider requestFilter rewrites the fake
// cookie to a real JWT carrying placement:permanent:read / :transition / :terms:write /
// placement:remedy:resolve / report:read.
//
// Convention (matches the placement + reporting consumer precedent): AUTHORIZATION refusals
// (403) are OMITTED — the client always sends its authorized cookie; scope/capability refusals
// are covered by the apps/api HTTP integration spec, not the contract. The GOVERNED domain
// errors the client actually renders (STATE_INVALID, FALLOFF_WINDOW_INVALID, REMEDY_INVALID,
// REMEDY_ALREADY_COMPLETED, TERMS_NOT_FOUND, TERMS_OVERLAP, TERMS_WINDOW_INVALID) ARE contracted.
//
// Date/instant fields are matched with like() (type = string): @db.Date columns serialize as a
// full ISO instant at UTC midnight while the terms-view calendar fields serialize as YYYY-MM-DD,
// and the consumer only depends on "a string it can render" — the exact serialization is the
// provider's to own. Amounts are scale-2 decimal strings; counts are numbers.

const provider = makeAtsWebProvider();

// Fixtures — byte-identical to the T7 provider states in pact/provider/src/verify-api.ts.
const PLACEMENT_ID = '00000000-0000-7000-8000-7e1200000001';
const PERMANENT_ID = '00000000-0000-7000-8000-7e1200000002';
const REPLACEMENT_PID = '00000000-0000-7000-8000-7e1200000004';
const SUB_ID = '00000000-0000-7000-8000-50b000000001';
const REQ_ID = '00000000-0000-7000-8000-4e9000000001';
const TALENT_ID_P = '00000000-0000-7000-8000-7a1e00000001';
const REC_BY = '00000000-0000-7000-8000-4ec000000001';

// A faithful PermanentPlacementView. Deliberately carries NO P3 term-version provenance
// (guarantee_term_version_id etc.) — the projection omits it (the snapshot is source of truth).
function permanentView(overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(PERMANENT_ID),
    tenant_id: uuid(TENANT_ID),
    placement_process_id: uuid(PLACEMENT_ID),
    submittal_id: uuid(SUB_ID),
    requisition_id: uuid(REQ_ID),
    talent_record_id: uuid(TALENT_ID_P),
    lifecycle_state: like('GUARANTEE_ACTIVE'),
    guarantee_start_date: like('2026-06-01'),
    guarantee_duration_days: like(365),
    guarantee_end_date: like('2027-06-01'),
    remedy_policy: like('REPLACEMENT'),
    guarantee_exposure_amount: like('10000.00'),
    guarantee_exposure_currency: like('USD'),
    terms_source: like('MANUAL'),
    recorded_by: uuid(REC_BY),
    created_at: like('2026-06-01T00:00:00.000Z'),
    falloff_effective_date: null,
    falloff_reason: null,
    falloff_recorded_by: null,
    falloff_recorded_at: null,
    remedy: null,
    ...overrides,
  };
}

// The server-derived remedy obligation child (present once a falloff has landed).
function remedyView(overrides: Record<string, unknown> = {}) {
  return {
    remedy_type: like('REPLACEMENT'),
    calculated_amount: null,
    currency: null,
    remaining_days: null,
    falloff_effective_date: like('2026-06-01'),
    due_at: like('2026-09-01T00:00:00.000Z'),
    completed_at: null,
    completed_by: null,
    completion_reference: null,
    replacement_placement_process_id: null,
    ...overrides,
  };
}

// A reusable requisition-level guarantee-term version (distinct from the per-placement snapshot).
function termVersionView(overrides: Record<string, unknown> = {}) {
  return {
    id: uuid('00000000-0000-7000-8000-7e1200000011'),
    tenant_id: uuid(TENANT_ID),
    requisition_id: uuid(REQ_ID),
    effective_from: like('2026-06-01'),
    effective_to: null,
    guarantee_duration_days: like(90),
    remedy_policy: like('REPLACEMENT'),
    guarantee_exposure_amount: like('10000.00'),
    currency: like('USD'),
    source_type: like('MANUAL'),
    source_reference: null,
    source_version: null,
    recorded_by: uuid(REC_BY),
    recorded_at: like('2026-06-01T00:00:00.000Z'),
    supersedes_version_id: null,
    correlation_id: null,
    ...overrides,
  };
}

// ===== GET /v1/placements/:id/permanent — the permanent-vs-contract discriminator =====
describe('ats-web → GET /v1/placements/:id/permanent', () => {
  it('returns 200 with { permanent: <view> } for a permanent placement', async () => {
    await provider
      .addInteraction()
      .given('an ats-web reader and a permanent placement exists')
      .uponReceiving('a permanent-placement read for a permanent placement')
      .withRequest('GET', `/v1/placements/${PLACEMENT_ID}/permanent`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ permanent: permanentView() });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/placements/${PLACEMENT_ID}/permanent`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { permanent: { lifecycle_state: string } | null };
        expect(body.permanent).not.toBeNull();
        expect(body.permanent?.lifecycle_state).toBe('GUARANTEE_ACTIVE');
      });
  });

  it('returns 200 with { permanent: null } for a contract/legacy placement', async () => {
    await provider
      .addInteraction()
      .given('an ats-web reader and a contract placement without a permanent aggregate exists')
      .uponReceiving('a permanent-placement read for a contract placement')
      .withRequest('GET', `/v1/placements/${PLACEMENT_ID}/permanent`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ permanent: null });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/placements/${PLACEMENT_ID}/permanent`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { permanent: unknown };
        expect(body.permanent).toBeNull();
      });
  });
});

// ===== POST /v1/placements/:id/permanent/transition — satisfy =====
describe('ats-web → POST /v1/placements/:id/permanent/transition', () => {
  it('returns 200 with the satisfied view when the guarantee window has elapsed', async () => {
    await provider
      .addInteraction()
      .given('an ats-web writer and a permanent placement whose guarantee window has elapsed exists')
      .uponReceiving('a guarantee-satisfied transition')
      .withRequest('POST', `/v1/placements/${PLACEMENT_ID}/permanent/transition`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
        b.jsonBody({ to: 'GUARANTEE_SATISFIED' });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(permanentView({ lifecycle_state: like('GUARANTEE_SATISFIED'), guarantee_end_date: like('2026-04-01') }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/placements/${PLACEMENT_ID}/permanent/transition`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: 'GUARANTEE_SATISFIED' }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { lifecycle_state: string };
        expect(body.lifecycle_state).toBe('GUARANTEE_SATISFIED');
      });
  });

  it('returns 422 STATE_INVALID for a premature satisfy (still within the window)', async () => {
    await provider
      .addInteraction()
      .given('an ats-web writer and a permanent placement still within its guarantee window exists')
      .uponReceiving('a premature guarantee-satisfied transition')
      .withRequest('POST', `/v1/placements/${PLACEMENT_ID}/permanent/transition`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
        b.jsonBody({ to: 'GUARANTEE_SATISFIED' });
      })
      .willRespondWith(422, (b) => {
        b.jsonBody(errorBody('PERMANENT_PLACEMENT_STATE_INVALID', 'the guarantee window has not yet elapsed'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/placements/${PLACEMENT_ID}/permanent/transition`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: 'GUARANTEE_SATISFIED' }),
        });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('PERMANENT_PLACEMENT_STATE_INVALID');
      });
  });
});

// ===== POST /v1/placements/:id/permanent/falloff — record a qualifying falloff =====
describe('ats-web → POST /v1/placements/:id/permanent/falloff', () => {
  const FALLOFF_OK = { effective_date: '2026-06-01', reason: 'CLIENT_TERMINATED_PERFORMANCE' };

  it('returns 200 with the remedy-due view (remedy obligation materialised)', async () => {
    await provider
      .addInteraction()
      .given('an ats-web writer and an active permanent placement within its guarantee window exists')
      .uponReceiving('a qualifying falloff record')
      .withRequest('POST', `/v1/placements/${PLACEMENT_ID}/permanent/falloff`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
        b.jsonBody(FALLOFF_OK);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(
          permanentView({
            lifecycle_state: like('REPLACEMENT_DUE'),
            guarantee_start_date: like('2026-01-01'),
            guarantee_end_date: like('2027-01-01'),
            falloff_effective_date: like('2026-06-01'),
            falloff_reason: like('CLIENT_TERMINATED_PERFORMANCE'),
            falloff_recorded_by: uuid(REC_BY),
            falloff_recorded_at: like('2026-06-01T00:00:00.000Z'),
            remedy: remedyView(),
          }),
        );
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/placements/${PLACEMENT_ID}/permanent/falloff`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(FALLOFF_OK),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { lifecycle_state: string; remedy: unknown };
        expect(body.lifecycle_state).toBe('REPLACEMENT_DUE');
        expect(body.remedy).not.toBeNull();
      });
  });

  it('returns 422 FALLOFF_WINDOW_INVALID for an out-of-window effective date', async () => {
    const FALLOFF_BAD = { effective_date: '2027-06-01', reason: 'CLIENT_TERMINATED_PERFORMANCE' };
    await provider
      .addInteraction()
      .given('an ats-web writer and an active permanent placement within its guarantee window exists')
      .uponReceiving('a falloff record with an out-of-window effective date')
      .withRequest('POST', `/v1/placements/${PLACEMENT_ID}/permanent/falloff`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
        b.jsonBody(FALLOFF_BAD);
      })
      .willRespondWith(422, (b) => {
        b.jsonBody(errorBody('PERMANENT_PLACEMENT_FALLOFF_WINDOW_INVALID', 'the falloff date is outside the guarantee window'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/placements/${PLACEMENT_ID}/permanent/falloff`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(FALLOFF_BAD),
        });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('PERMANENT_PLACEMENT_FALLOFF_WINDOW_INVALID');
      });
  });
});

// ===== POST /v1/placements/:id/permanent/remedy/complete — evidence-gated completion =====
describe('ats-web → POST /v1/placements/:id/permanent/remedy/complete', () => {
  it('returns 200 with the completed view for a valid replacement reference', async () => {
    const body = { replacement_placement_process_id: REPLACEMENT_PID };
    await provider
      .addInteraction()
      .given('an ats-web resolver and a permanent placement with an open replacement obligation exists')
      .uponReceiving('a replacement remedy completion with a valid replacement reference')
      .withRequest('POST', `/v1/placements/${PLACEMENT_ID}/permanent/remedy/complete`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
        b.jsonBody(body);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(
          permanentView({
            lifecycle_state: like('REMEDY_COMPLETED'),
            guarantee_start_date: like('2026-01-01'),
            guarantee_end_date: like('2027-01-01'),
            falloff_effective_date: like('2026-06-01'),
            falloff_reason: like('CLIENT_TERMINATED_PERFORMANCE'),
            falloff_recorded_by: uuid(REC_BY),
            falloff_recorded_at: like('2026-06-01T00:00:00.000Z'),
            remedy: remedyView({
              completed_at: like('2026-08-15T00:00:00.000Z'),
              completed_by: uuid(REC_BY),
              replacement_placement_process_id: uuid(REPLACEMENT_PID),
            }),
          }),
        );
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/placements/${PLACEMENT_ID}/permanent/remedy/complete`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(200);
        const parsed = (await res.json()) as { lifecycle_state: string };
        expect(parsed.lifecycle_state).toBe('REMEDY_COMPLETED');
      });
  });

  it('returns 200 with the completed view for a monetary (refund) external reference', async () => {
    const body = { external_reference: 'CN-2026-0001' };
    await provider
      .addInteraction()
      .given('an ats-web resolver and a permanent placement with an open refund obligation exists')
      .uponReceiving('a refund remedy completion with an external reference')
      .withRequest('POST', `/v1/placements/${PLACEMENT_ID}/permanent/remedy/complete`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
        b.jsonBody(body);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(
          permanentView({
            lifecycle_state: like('REMEDY_COMPLETED'),
            remedy_policy: like('REFUND'),
            guarantee_start_date: like('2026-01-01'),
            guarantee_end_date: like('2027-01-01'),
            falloff_effective_date: like('2026-06-01'),
            falloff_reason: like('TALENT_RESIGNED'),
            falloff_recorded_by: uuid(REC_BY),
            falloff_recorded_at: like('2026-06-01T00:00:00.000Z'),
            remedy: remedyView({
              remedy_type: like('REFUND'),
              calculated_amount: like('5863.01'),
              currency: like('USD'),
              completed_at: like('2026-08-15T00:00:00.000Z'),
              completed_by: uuid(REC_BY),
              completion_reference: like('CN-2026-0001'),
            }),
          }),
        );
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/placements/${PLACEMENT_ID}/permanent/remedy/complete`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(200);
        const parsed = (await res.json()) as { lifecycle_state: string };
        expect(parsed.lifecycle_state).toBe('REMEDY_COMPLETED');
      });
  });

  it('returns 422 REMEDY_INVALID for invalid completion evidence', async () => {
    // A replacement id that does not resolve to a same-requisition PERMANENT/STARTED placement.
    const body = { replacement_placement_process_id: '00000000-0000-7000-8000-000000000bad' };
    await provider
      .addInteraction()
      .given('an ats-web resolver and a permanent placement with an open replacement obligation exists')
      .uponReceiving('a replacement remedy completion with an unresolvable reference')
      .withRequest('POST', `/v1/placements/${PLACEMENT_ID}/permanent/remedy/complete`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
        b.jsonBody(body);
      })
      .willRespondWith(422, (b) => {
        b.jsonBody(errorBody('PERMANENT_PLACEMENT_REMEDY_INVALID', 'the remedy completion evidence is invalid'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/placements/${PLACEMENT_ID}/permanent/remedy/complete`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(422);
        const parsed = (await res.json()) as { error: { code: string } };
        expect(parsed.error.code).toBe('PERMANENT_PLACEMENT_REMEDY_INVALID');
      });
  });

  it('returns 409 REMEDY_ALREADY_COMPLETED when the remedy is already resolved', async () => {
    const body = { external_reference: 'CN-2026-0002' };
    await provider
      .addInteraction()
      .given('an ats-web resolver and a permanent placement whose remedy is already completed exists')
      .uponReceiving('a remedy completion for an already-completed remedy')
      .withRequest('POST', `/v1/placements/${PLACEMENT_ID}/permanent/remedy/complete`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
        b.jsonBody(body);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(errorBody('PERMANENT_PLACEMENT_REMEDY_ALREADY_COMPLETED', 'the remedy obligation is already completed'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/placements/${PLACEMENT_ID}/permanent/remedy/complete`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(409);
        const parsed = (await res.json()) as { error: { code: string } };
        expect(parsed.error.code).toBe('PERMANENT_PLACEMENT_REMEDY_ALREADY_COMPLETED');
      });
  });
});

// ===== GET/POST /v1/permanent-placement-guarantee-terms/requisitions/:id — reusable terms =====
const TERMS_BASE = '/v1/permanent-placement-guarantee-terms/requisitions';

describe('ats-web → guarantee-terms history + effective reads', () => {
  it('returns 200 with the version history (newest first)', async () => {
    await provider
      .addInteraction()
      .given('an ats-web reader and a requisition with a guarantee-terms history exists')
      .uponReceiving('a guarantee-terms history read')
      .withRequest('GET', `${TERMS_BASE}/${REQ_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: [
            termVersionView(),
            termVersionView({
              id: uuid('00000000-0000-7000-8000-7e1200000012'),
              effective_from: like('2026-01-01'),
              effective_to: like('2026-06-01'),
            }),
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${TERMS_BASE}/${REQ_ID}`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: Array<{ effective_to: string | null }> };
        expect(body.items).toHaveLength(2);
        expect(body.items[0].effective_to).toBeNull(); // open current first
      });
  });

  it('returns 200 with an empty history when the requisition has no terms', async () => {
    await provider
      .addInteraction()
      .given('an ats-web reader and a requisition with no guarantee terms exists')
      .uponReceiving('a guarantee-terms history read (empty)')
      .withRequest('GET', `${TERMS_BASE}/${REQ_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: [] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${TERMS_BASE}/${REQ_ID}`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items).toEqual([]);
      });
  });

  it('returns 200 with the effective version', async () => {
    await provider
      .addInteraction()
      .given('an ats-web reader and a requisition with a guarantee-terms history exists')
      .uponReceiving('a guarantee-terms effective read')
      .withRequest('GET', `${TERMS_BASE}/${REQ_ID}/effective`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(termVersionView());
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${TERMS_BASE}/${REQ_ID}/effective`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { effective_to: string | null };
        expect(body.effective_to).toBeNull();
      });
  });

  it('returns 404 TERMS_NOT_FOUND when there is no effective version', async () => {
    await provider
      .addInteraction()
      .given('an ats-web reader and a requisition with no guarantee terms exists')
      .uponReceiving('a guarantee-terms effective read with no effective version')
      .withRequest('GET', `${TERMS_BASE}/${REQ_ID}/effective`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(404, (b) => {
        b.jsonBody(errorBody('PERMANENT_PLACEMENT_TERMS_NOT_FOUND', 'no effective guarantee terms for the requisition'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${TERMS_BASE}/${REQ_ID}/effective`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('PERMANENT_PLACEMENT_TERMS_NOT_FOUND');
      });
  });
});

describe('ats-web → guarantee-terms create + revise', () => {
  const CREATE_REQ = {
    effective_from: '2026-06-01',
    guarantee_duration_days: 90,
    remedy_policy: 'REPLACEMENT',
    guarantee_exposure_amount: '10000.00',
    currency: 'USD',
    source_type: 'MANUAL',
  };

  it('returns 201 with the created version', async () => {
    await provider
      .addInteraction()
      .given('an ats-web reader and a requisition with no guarantee terms exists')
      .uponReceiving('a guarantee-terms create')
      .withRequest('POST', `${TERMS_BASE}/${REQ_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
        b.jsonBody(CREATE_REQ);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody(termVersionView());
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${TERMS_BASE}/${REQ_ID}`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(CREATE_REQ),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { effective_to: string | null };
        expect(body.effective_to).toBeNull();
      });
  });

  it('returns 409 TERMS_OVERLAP when the new window overlaps an existing open version', async () => {
    await provider
      .addInteraction()
      .given('an ats-web writer and a requisition with an open current guarantee-terms version exists')
      .uponReceiving('a guarantee-terms create that overlaps the open version')
      .withRequest('POST', `${TERMS_BASE}/${REQ_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
        b.jsonBody(CREATE_REQ);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(errorBody('PERMANENT_PLACEMENT_TERMS_OVERLAP', 'the guarantee-terms window overlaps an existing version'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${TERMS_BASE}/${REQ_ID}`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(CREATE_REQ),
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('PERMANENT_PLACEMENT_TERMS_OVERLAP');
      });
  });

  it('returns 201 with the successor version on a forward revision', async () => {
    const REVISE_REQ = { ...CREATE_REQ, effective_from: '2026-12-01' };
    await provider
      .addInteraction()
      .given('an ats-web writer and a requisition with an open current guarantee-terms version exists')
      .uponReceiving('a forward guarantee-terms revision')
      .withRequest('POST', `${TERMS_BASE}/${REQ_ID}/revise`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
        b.jsonBody(REVISE_REQ);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody(termVersionView({ effective_from: like('2026-12-01') }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${TERMS_BASE}/${REQ_ID}/revise`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(REVISE_REQ),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { effective_to: string | null };
        expect(body.effective_to).toBeNull();
      });
  });

  it('returns 422 TERMS_WINDOW_INVALID on a backdated revision', async () => {
    const REVISE_BAD = { ...CREATE_REQ, effective_from: '2025-01-01' };
    await provider
      .addInteraction()
      .given('an ats-web writer and a requisition with an open current guarantee-terms version exists')
      .uponReceiving('a backdated guarantee-terms revision')
      .withRequest('POST', `${TERMS_BASE}/${REQ_ID}/revise`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
        b.jsonBody(REVISE_BAD);
      })
      .willRespondWith(422, (b) => {
        b.jsonBody(errorBody('PERMANENT_PLACEMENT_TERMS_WINDOW_INVALID', 'the revision effective date is invalid'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${TERMS_BASE}/${REQ_ID}/revise`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(REVISE_BAD),
        });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('PERMANENT_PLACEMENT_TERMS_WINDOW_INVALID');
      });
  });
});

// ===== GET /v1/reports/guarantee-exposure — the summary report =====
describe('ats-web → GET /v1/reports/guarantee-exposure', () => {
  const FROM = '2026-08-01T00:00:00Z';
  const TO = '2026-09-01T00:00:00Z';

  it('returns 200 with a per-currency exposure summary', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and permanent-placement guarantee exposure data exist')
      .uponReceiving('a guarantee-exposure report read')
      .withRequest('GET', '/v1/reports/guarantee-exposure', (b) => {
        b.query({ from: FROM, to: TO });
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          period: { from: like(FROM), to: like(TO) },
          cohort_count: like(1),
          exposure_by_currency: [
            {
              currency: like('USD'),
              total: like('10000.00'),
              active: like('10000.00'),
              satisfied: like('0.00'),
              fell_off: like('0.00'),
              at_risk: like('10000.00'),
            },
          ],
          states: {
            active: like(1),
            satisfied: like(0),
            fell_off: like(0),
            remedy_due: { replacement: like(0), refund: like(0), prorated_credit: like(0) },
            remedy_completed: like(0),
          },
          remedy_obligation_by_currency: [],
          falloff_rate: like(0),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/reports/guarantee-exposure?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { cohort_count: number; exposure_by_currency: unknown[] };
        expect(body.cohort_count).toBe(1);
        expect(body.exposure_by_currency).toHaveLength(1);
      });
  });

  it('returns 200 with a zero cohort when no placements started in the window', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and no permanent-placement guarantee exposure data exist')
      .uponReceiving('a guarantee-exposure report read (empty cohort)')
      .withRequest('GET', '/v1/reports/guarantee-exposure', (b) => {
        b.query({ from: FROM, to: TO });
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          period: { from: like(FROM), to: like(TO) },
          cohort_count: like(0),
          exposure_by_currency: [],
          states: {
            active: like(0),
            satisfied: like(0),
            fell_off: like(0),
            remedy_due: { replacement: like(0), refund: like(0), prorated_credit: like(0) },
            remedy_completed: like(0),
          },
          remedy_obligation_by_currency: [],
          falloff_rate: like(0),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/reports/guarantee-exposure?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { cohort_count: number };
        expect(body.cohort_count).toBe(0);
      });
  });
});
