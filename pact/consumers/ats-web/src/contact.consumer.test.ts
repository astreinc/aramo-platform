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

// PC-5a — Pact consumer for ats-web, contact domain (Gate-2a desk, part 3).
// Merges into ats-web-aramo-core.json.
//
// Scope (PC-5 Directive §3 + Gate-5 ruling): the contact CRUD spine ats-web
// calls — 5 happy interactions:
//   - GET /v1/contacts (list, {items});
//   - GET /v1/contacts?paged=true (faceted ContactSearchPage; no ?q=);
//   - GET /v1/contacts/:id;
//   - POST /v1/contacts (201);
//   - PATCH /v1/contacts/:id (200).
//
// illegal-state: 0-by-substrate (contact is CRUD, no transition surface).
// idempotency: 0-by-substrate (no Idempotency-Key).
// refusal: 0-by-ruling (relationship_role/preference vocab 400 + company_id
//   NOT_FOUND are refusals for params/values the FE constrains → hardening
//   park; DELETE /v1/contacts/:id is EXCLUDE-R2, no ats-web call site).
//
// company_name (a read-time enrichment on the paged/detail reads) is NOT
// asserted — it is nullable and provider-fuller keys are tolerated by Pact.
//
// Provider guard chain: @RequireCapability('ats') + @RequireScopes('contact:*')
// + @RequireSiteMatch() (unconstrained). company:read:all short-circuits the
// visibility resolver (contact list/detail call resolveVisibility).

const provider = makeAtsWebProvider();

const COMPANY_ID = '00000000-0000-7000-8000-c00000000001';
const CONTACT_ID = '00000000-0000-7000-8000-c07ac0000001';

function contactView(
  id: string | undefined,
  opts: { firstName?: string; lastName?: string; isHot?: boolean } = {},
) {
  return {
    id: id === undefined ? uuid() : uuid(id),
    tenant_id: uuid(TENANT_ID),
    site_id: null,
    company_id: uuid(COMPANY_ID),
    first_name: like(opts.firstName ?? 'Ada'),
    last_name: like(opts.lastName ?? 'Byron'),
    is_hot: opts.isHot === undefined ? like(false) : opts.isHot,
    left_company: like(false),
    created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
    updated_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
  };
}

// ======================================================================
// GET /v1/contacts — happy (list + paged facets)
// ======================================================================
describe('ats-web → GET /v1/contacts', () => {
  it('returns 200 with the tenant contact list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a contact exist')
      .uponReceiving('a contacts list read')
      .withRequest('GET', '/v1/contacts', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: [contactView(CONTACT_ID)] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/contacts`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });

  it('returns 200 ContactSearchPage for the paged faceted list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a contact exist')
      .uponReceiving('a paged contacts list')
      .withRequest('GET', '/v1/contacts', (b) => {
        b.query({ paged: 'true' }).headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: [contactView(CONTACT_ID)],
          next_cursor: null,
          facets: {
            relationship_role: like([]),
            preference: like([]),
            company: like([]),
            hot: like(0),
            quiet: like(0),
            former: like(0),
          },
          total: like(1),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/contacts?paged=true`, {
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
// GET /v1/contacts/:id — happy
// ======================================================================
describe('ats-web → GET /v1/contacts/:id', () => {
  it('returns 200 with the contact', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a contact exist')
      .uponReceiving('a contact detail read')
      .withRequest('GET', `/v1/contacts/${CONTACT_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(contactView(CONTACT_ID));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/contacts/${CONTACT_ID}`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { id: string };
        expect(body.id).toBe(CONTACT_ID);
      });
  });
});

// ======================================================================
// POST /v1/contacts — happy (create; 201)
// ======================================================================
describe('ats-web → POST /v1/contacts', () => {
  it('returns 201 with the created contact', async () => {
    const CREATE_BODY = {
      company_id: COMPANY_ID,
      first_name: 'Grace',
      last_name: 'Hopper',
    };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a company exist')
      .uponReceiving('a contact create')
      .withRequest('POST', '/v1/contacts', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          CREATE_BODY,
        );
      })
      .willRespondWith(201, (b) => {
        b.jsonBody(contactView(undefined, { firstName: 'Grace', lastName: 'Hopper' }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/contacts`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(CREATE_BODY),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { first_name: string };
        expect(body.first_name).toBe('Grace');
      });
  });
});

// ======================================================================
// PATCH /v1/contacts/:id — happy (update; 200)
// ======================================================================
describe('ats-web → PATCH /v1/contacts/:id', () => {
  it('returns 200 with the updated contact', async () => {
    const UPDATE_BODY = { is_hot: true };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a contact exist')
      .uponReceiving('a contact update')
      .withRequest('PATCH', `/v1/contacts/${CONTACT_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          UPDATE_BODY,
        );
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(contactView(CONTACT_ID, { isHot: true }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/contacts/${CONTACT_ID}`, {
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

beforeAll(() => undefined);
afterAll(() => undefined);
