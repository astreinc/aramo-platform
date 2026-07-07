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

// PC-5a — Pact consumer for ats-web, company domain (Gate-2a desk, part 1).
// Merges into ats-web-aramo-core.json with engagement + submittal +
// examination + talent-record + (PC-5a) assignments + contact.
//
// Scope (PC-5 Directive §3 + Gate-5 ruling): the company CRUD spine +
// departments + address-lookup graceful-degradation guarantee. 10 happy
// interactions:
//   - GET /v1/companies (list, {items} envelope);
//   - GET /v1/companies?paged=true (faceted CompanySearchPage; no ?q=, so
//     company:search isn't exercised — the trigram path stays out of scope);
//   - GET /v1/companies/:id;
//   - POST /v1/companies (201);
//   - PATCH /v1/companies/:id (200);
//   - GET /v1/companies/:company_id/departments (list);
//   - POST /v1/companies/:company_id/departments (201);
//   - DELETE /v1/companies/:company_id/departments/:id (204);
//   - GET /v1/address-lookup/autocomplete — degraded 200 {suggestions:[]};
//   - GET /v1/address-lookup/details — degraded 200 {details:null}.
//
// illegal-state: 0-by-substrate (company/department/address-lookup have no
//   HTTP state-transition surface — CRUD + a stateless lookup).
// idempotency: 0-by-substrate (no Idempotency-Key on any desk endpoint).
// refusal: 0-by-ruling (framework scope/validation/not-found refusals →
//   suite-wide hardening park; the only desk business refusals live on the
//   pipeline state machine, PC-5c).
//
// The commercial fields (fee_model, default_*_pct, payment_terms, …) are NOT
// asserted: the recruiter JWT holds no company:read_commercial scope, so the
// CompensationFieldMaskInterceptor strips them — the contract pins the shape
// a non-commercial holder sees (extra provider keys are tolerated by Pact).
//
// Provider guard chain: @RequireCapability('ats') (TENANT_ID entitled) +
// @RequireScopes('company:*') on the recruiter JWT + @RequireSiteMatch()
// (passes unconstrained — tenant-wide principal, no site_id claim).
// company:read:all short-circuits the VisibilityInterceptor resolver to zero
// reads (Gate-5 Q4: contracts pin shapes, not the visibility-restricted path).

const provider = makeAtsWebProvider();

const COMPANY_ID = '00000000-0000-7000-8000-c00000000001';
const DEPT_ID = '00000000-0000-7000-8000-de0000000001';

// Faithful core of CompanyView (Pact tolerates the provider's fuller row).
function companyView(
  id: string | undefined,
  opts: { name?: string; isHot?: boolean } = {},
) {
  return {
    id: id === undefined ? uuid() : uuid(id),
    tenant_id: uuid(TENANT_ID),
    site_id: null,
    name: like(opts.name ?? 'Acme Corp'),
    is_hot: opts.isHot === undefined ? like(false) : opts.isHot,
    status: like('active'),
    exclusivity: like(false),
    off_limits: like(false),
    tags: like([]),
    created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
    updated_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
  };
}

function departmentView(id: string | undefined, opts: { name?: string } = {}) {
  return {
    id: id === undefined ? uuid() : uuid(id),
    tenant_id: uuid(TENANT_ID),
    site_id: null,
    company_id: uuid(COMPANY_ID),
    name: like(opts.name ?? 'Engineering'),
    created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
    updated_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
  };
}

// ======================================================================
// GET /v1/companies — happy (list + paged facets)
// ======================================================================
describe('ats-web → GET /v1/companies', () => {
  it('returns 200 with the tenant company list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a company exist')
      .uponReceiving('a companies list read')
      .withRequest('GET', '/v1/companies', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: [companyView(COMPANY_ID)] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/companies`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: Array<{ id: string }> };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });

  it('returns 200 CompanySearchPage for the paged faceted list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a company exist')
      .uponReceiving('a paged companies list')
      .withRequest('GET', '/v1/companies', (b) => {
        b.query({ paged: 'true' }).headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: [companyView(COMPANY_ID)],
          next_cursor: null,
          facets: {
            relationship: like([]),
            tier: like([]),
            industry: like([]),
            hot: like(0),
            off_limits: like(0),
            exclusivity: like(0),
            quiet: like(0),
          },
          total: like(1),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/companies?paged=true`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          items: unknown[];
          next_cursor: string | null;
        };
        expect(body.items.length).toBeGreaterThan(0);
        expect(body.next_cursor).toBeNull();
      });
  });
});

// ======================================================================
// GET /v1/companies/:id — happy
// ======================================================================
describe('ats-web → GET /v1/companies/:id', () => {
  it('returns 200 with the company', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a company exist')
      .uponReceiving('a company detail read')
      .withRequest('GET', `/v1/companies/${COMPANY_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(companyView(COMPANY_ID));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/companies/${COMPANY_ID}`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { id: string };
        expect(body.id).toBe(COMPANY_ID);
      });
  });
});

// ======================================================================
// POST /v1/companies — happy (create; 201)
// ======================================================================
describe('ats-web → POST /v1/companies', () => {
  it('returns 201 with the created company', async () => {
    const CREATE_BODY = { name: 'Globex' };
    await provider
      .addInteraction()
      .given('an ats-web recruiter can create companies')
      .uponReceiving('a company create')
      .withRequest('POST', '/v1/companies', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          CREATE_BODY,
        );
      })
      .willRespondWith(201, (b) => {
        b.jsonBody(companyView(undefined, { name: 'Globex' }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/companies`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(CREATE_BODY),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { name: string };
        expect(body.name).toBe('Globex');
      });
  });
});

// ======================================================================
// PATCH /v1/companies/:id — happy (update; 200)
// ======================================================================
describe('ats-web → PATCH /v1/companies/:id', () => {
  it('returns 200 with the updated company', async () => {
    const UPDATE_BODY = { is_hot: true };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a company exist')
      .uponReceiving('a company update')
      .withRequest('PATCH', `/v1/companies/${COMPANY_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          UPDATE_BODY,
        );
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(companyView(COMPANY_ID, { isHot: true }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/companies/${COMPANY_ID}`, {
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
// Company departments — happy (list, create, delete)
// ======================================================================
describe('ats-web → company departments', () => {
  it('returns 200 with the department list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a company with a department exist')
      .uponReceiving('a company departments list read')
      .withRequest('GET', `/v1/companies/${COMPANY_ID}/departments`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: [departmentView(DEPT_ID)] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/companies/${COMPANY_ID}/departments`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });

  it('returns 201 with the created department', async () => {
    const CREATE_BODY = { name: 'Sales' };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a company exist')
      .uponReceiving('a company department create')
      .withRequest('POST', `/v1/companies/${COMPANY_ID}/departments`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          CREATE_BODY,
        );
      })
      .willRespondWith(201, (b) => {
        b.jsonBody(departmentView(undefined, { name: 'Sales' }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/companies/${COMPANY_ID}/departments`,
          {
            method: 'POST',
            headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
            body: JSON.stringify(CREATE_BODY),
          },
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as { name: string };
        expect(body.name).toBe('Sales');
      });
  });

  it('returns 204 on department delete', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a company with a department exist')
      .uponReceiving('a company department delete')
      .withRequest(
        'DELETE',
        `/v1/companies/${COMPANY_ID}/departments/${DEPT_ID}`,
        (b) => {
          b.headers({ Cookie: like(ACCESS_COOKIE) });
        },
      )
      .willRespondWith(204)
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/companies/${COMPANY_ID}/departments/${DEPT_ID}`,
          { method: 'DELETE', headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(204);
      });
  });
});

// ======================================================================
// Address-lookup — degraded-mode guarantee (provider unavailable → 200
// empty/null, never 5xx). Given-states name the degraded mode explicitly.
// ======================================================================
describe('ats-web → address-lookup (degraded mode)', () => {
  it('returns 200 with an empty suggestions list when the provider is unavailable', async () => {
    await provider
      .addInteraction()
      .given('the address-lookup provider is in degraded mode')
      .uponReceiving('an address autocomplete with the provider degraded')
      .withRequest('GET', '/v1/address-lookup/autocomplete', (b) => {
        b.query({ query: 'Acme Plaza' }).headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ suggestions: [] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/address-lookup/autocomplete?query=Acme%20Plaza`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { suggestions: unknown[] };
        expect(body.suggestions).toHaveLength(0);
      });
  });

  it('returns 200 with null details when the provider is unavailable', async () => {
    await provider
      .addInteraction()
      .given('the address-lookup provider is in degraded mode')
      .uponReceiving('an address details lookup with the provider degraded')
      .withRequest('GET', '/v1/address-lookup/details', (b) => {
        b.query({ place_id: 'test-place-id' }).headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ details: null });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/address-lookup/details?place_id=test-place-id`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { details: unknown };
        expect(body.details).toBeNull();
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
