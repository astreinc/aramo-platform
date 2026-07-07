import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  ISO_TIMESTAMP,
  TENANT_ID,
  like,
  makeAtsWebProvider,
  regex,
  uuid,
} from './support/ats-web-pact.js';

// PC-5b — Pact consumer for ats-web, requisition domain (Gate-2a desk, part
// 2). Merges into ats-web-aramo-core.json.
//
// Scope (PC-5 Directive §3 + Gate-5 ruling): the requisition spine ats-web
// calls that verify WITHOUT an AI mock — 9 happy interactions:
//   - GET /v1/requisitions (list, {items}; no ?paged= variant exists);
//   - GET /v1/requisitions/:id;
//   - POST /v1/requisitions (201);
//   - PATCH /v1/requisitions/:id (200);
//   - GET /v1/requisitions/:id/profile (profile-less empty DTO, 200 — the
//     "no golden profile yet" path, never 404);
//   - POST /v1/requisitions/:id/profile/confirm (200; DB-only, no AI — stamps
//     golden_profile_id);
//   - GET /v1/requisitions/:id/assignments ({items});
//   - POST /v1/requisitions/:id/assignments (201, full row);
//   - DELETE /v1/requisitions/:id/assignments/:user_id (204).
//
// illegal-state: 0-by-substrate (RequisitionStatus is a stored enum with no
//   transition rules — the pipeline is the desk's only state machine, PC-5c).
// idempotency: 0-by-substrate (no Idempotency-Key).
// refusal: 0-by-ruling (framework scope/validation/not-found → hardening
//   park; DELETE /v1/requisitions/:id is EXCLUDE-R2, no ats-web call site).
//
// DEFER-INFRA (→ PC-5-aidraft, @aramo/ai-draft boundary carve-out pre-
//   approved): POST /v1/requisitions/intake, POST .../profile/draft — both
//   make a real class-injected AiDraftService LLM call on the happy path.
//
// The compensation (pay_rate_*, salary_*, …) and financial (target_margin_*,
// min/max_*_rate, …) keys are NOT asserted: the recruiter JWT holds no
// compensation:view:* / requisition:view:financials scopes, so the
// CompensationFieldMaskInterceptor strips them — the contract pins the shape
// a non-commercial holder sees (extra provider keys tolerated by Pact).
//
// Provider guard chain: @RequireCapability('ats') + @RequireScopes
// (requisition:read/create/edit/profile:generate/assign) + @RequireSiteMatch()
// (unconstrained). company:read:all + requisition:read:all short-circuit the
// VisibilityInterceptor to zero reads on the GET routes.

const provider = makeAtsWebProvider();

const REQ_ID = '00000000-0000-7000-8000-4e9000000001';
const REQ_COMPANY_ID = '00000000-0000-7000-8000-c00000000001';
const REQ_ASSIGN_USER_ID = '00000000-0000-7000-8000-115e00000002';
const REQ_ASSIGNMENT_ID = '00000000-0000-7000-8000-a55160000002';

// Faithful non-commercial core of RequisitionView (Pact tolerates the fuller
// row; the 13 comp + 7 financial keys are stripped for this actor).
function requisitionView(
  id: string | undefined,
  opts: { title?: string; isHot?: boolean; goldenProfileId?: unknown } = {},
) {
  return {
    id: id === undefined ? uuid() : uuid(id),
    tenant_id: uuid(TENANT_ID),
    site_id: null,
    title: like(opts.title ?? 'Senior Engineer'),
    company_id: uuid(REQ_COMPANY_ID),
    status: like('active'),
    is_hot: opts.isHot === undefined ? like(false) : opts.isHot,
    openings: like(1),
    openings_available: like(1),
    golden_profile_id:
      opts.goldenProfileId === undefined ? null : opts.goldenProfileId,
    created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
    updated_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
  };
}

function assignmentRow() {
  return {
    id: uuid(REQ_ASSIGNMENT_ID),
    tenant_id: uuid(TENANT_ID),
    requisition_id: uuid(REQ_ID),
    user_id: uuid(REQ_ASSIGN_USER_ID),
    assigned_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
    assigned_by_id: null,
  };
}

// ======================================================================
// GET /v1/requisitions — happy (list)
// ======================================================================
describe('ats-web → GET /v1/requisitions', () => {
  it('returns 200 with the requisition list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a requisition exist')
      .uponReceiving('a requisitions list read')
      .withRequest('GET', '/v1/requisitions', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: [requisitionView(REQ_ID)] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/requisitions`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });
});

// ======================================================================
// GET /v1/requisitions/:id — happy
// ======================================================================
describe('ats-web → GET /v1/requisitions/:id', () => {
  it('returns 200 with the requisition', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a requisition exist')
      .uponReceiving('a requisition detail read')
      .withRequest('GET', `/v1/requisitions/${REQ_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(requisitionView(REQ_ID));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/requisitions/${REQ_ID}`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { id: string };
        expect(body.id).toBe(REQ_ID);
      });
  });
});

// ======================================================================
// POST /v1/requisitions — happy (create; 201)
// ======================================================================
describe('ats-web → POST /v1/requisitions', () => {
  it('returns 201 with the created requisition', async () => {
    const CREATE_BODY = { title: 'Staff Engineer', company_id: REQ_COMPANY_ID };
    await provider
      .addInteraction()
      .given('an ats-web recruiter can create requisitions')
      .uponReceiving('a requisition create')
      .withRequest('POST', '/v1/requisitions', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          CREATE_BODY,
        );
      })
      .willRespondWith(201, (b) => {
        b.jsonBody(requisitionView(undefined, { title: 'Staff Engineer' }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/requisitions`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(CREATE_BODY),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { title: string };
        expect(body.title).toBe('Staff Engineer');
      });
  });
});

// ======================================================================
// PATCH /v1/requisitions/:id — happy (update; 200)
// ======================================================================
describe('ats-web → PATCH /v1/requisitions/:id', () => {
  it('returns 200 with the updated requisition', async () => {
    const UPDATE_BODY = { is_hot: true };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a requisition exist')
      .uponReceiving('a requisition update')
      .withRequest('PATCH', `/v1/requisitions/${REQ_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          UPDATE_BODY,
        );
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(requisitionView(REQ_ID, { isHot: true }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/requisitions/${REQ_ID}`, {
          method: 'PATCH',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(UPDATE_BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { is_hot: boolean };
        expect(body.is_hot).toBe(true);
      });
  });
});

// ======================================================================
// GET /v1/requisitions/:id/profile — happy (profile-less empty DTO)
// ======================================================================
describe('ats-web → GET /v1/requisitions/:id/profile', () => {
  it('returns 200 with the empty profile when none is confirmed', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a requisition exist')
      .uponReceiving('a requisition profile read (profile-less)')
      .withRequest('GET', `/v1/requisitions/${REQ_ID}/profile`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          requisition_id: uuid(REQ_ID),
          golden_profile_id: null,
          has_profile: false,
          jd_text: '',
          role_family: null,
          seniority_level: null,
          generated_by: null,
          required_skills: [],
          preferred_skills: [],
          critical_skills: [],
          experience: { industries: [] },
          constraints: {},
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/requisitions/${REQ_ID}/profile`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { has_profile: boolean };
        expect(body.has_profile).toBe(false);
      });
  });
});

// ======================================================================
// POST /v1/requisitions/:id/profile/confirm — happy (DB-only; stamps id)
// ======================================================================
describe('ats-web → POST /v1/requisitions/:id/profile/confirm', () => {
  it('returns 200 with the requisition and a stamped golden_profile_id', async () => {
    const CONFIRM_BODY = {
      jd_text: '',
      golden_profile: {
        jd_text: '',
        generated_by: 'manual',
        required_skills: [],
        preferred_skills: [],
        critical_skills: [],
        experience: { industries: [] },
        constraints: {},
      },
    };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a requisition exist')
      .uponReceiving('a requisition profile confirm (manual)')
      .withRequest('POST', `/v1/requisitions/${REQ_ID}/profile/confirm`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          CONFIRM_BODY,
        );
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(requisitionView(REQ_ID, { goldenProfileId: uuid() }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/requisitions/${REQ_ID}/profile/confirm`,
          {
            method: 'POST',
            headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
            body: JSON.stringify(CONFIRM_BODY),
          },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { golden_profile_id: string | null };
        expect(body.golden_profile_id).not.toBeNull();
      });
  });
});

// ======================================================================
// Requisition assignments — happy (list, create, delete)
// ======================================================================
describe('ats-web → requisition assignments', () => {
  it('returns 200 with the assignment list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a requisition with an assignment exist')
      .uponReceiving('a requisition assignments list read')
      .withRequest('GET', `/v1/requisitions/${REQ_ID}/assignments`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: [assignmentRow()] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/requisitions/${REQ_ID}/assignments`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });

  it('returns 201 with the created assignment', async () => {
    const BODY = { user_id: REQ_ASSIGN_USER_ID };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a requisition exist')
      .uponReceiving('a requisition assignment create')
      .withRequest('POST', `/v1/requisitions/${REQ_ID}/assignments`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          BODY,
        );
      })
      .willRespondWith(201, (b) => {
        // assigned_by_id is set from the actor on create (non-null); omitted
        // from the assertion (Pact tolerates the provider including it).
        b.jsonBody({
          id: uuid(),
          tenant_id: uuid(TENANT_ID),
          requisition_id: uuid(REQ_ID),
          user_id: uuid(REQ_ASSIGN_USER_ID),
          assigned_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/requisitions/${REQ_ID}/assignments`,
          {
            method: 'POST',
            headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
            body: JSON.stringify(BODY),
          },
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as { requisition_id: string };
        expect(body.requisition_id).toBe(REQ_ID);
      });
  });

  it('returns 204 on assignment delete', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a requisition with an assignment exist')
      .uponReceiving('a requisition assignment delete')
      .withRequest(
        'DELETE',
        `/v1/requisitions/${REQ_ID}/assignments/${REQ_ASSIGN_USER_ID}`,
        (b) => {
          b.headers({ Cookie: like(ACCESS_COOKIE) });
        },
      )
      .willRespondWith(204)
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/requisitions/${REQ_ID}/assignments/${REQ_ASSIGN_USER_ID}`,
          { method: 'DELETE', headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(204);
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
