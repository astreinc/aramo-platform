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

// PC-4 — Pact consumer for ats-web, talent-record domain (Gate-1 remainder,
// stable subset). Merges into ats-web-aramo-core.json with engagement +
// submittal + examination.
//
// Scope (PC-4 Directive §3 + Gate-5 ruling): the STABLE talent-record CRUD
// surface ats-web calls — 4 happy interactions. The promotion / advisory /
// sourcing / trust surface + talent-record DETAIL (get:id) all DEFER-TR2-
// MOTION to PC-4b (their shapes are in motion under TR-2 B3a, PR #385:
// projectViewWithSupersession, trust_bands, subject-resolution). The resume
// flow (resume-upload-url, draft-from-resume) DEFER-INFRA to PC-4a-resume
// (class-injected ObjectStorageService/ResumeParserService need an eslint
// boundary carve-out, pre-approved for that follow-up).
//
//   - happy: 4 — list, search (paged, live-record filter), create, update;
//   - illegal-state: 0-by-substrate (talent-record has no HTTP state-
//     transition surface — CRUD + link only);
//   - idempotency: 0-by-substrate (no Idempotency-Key on talent-record);
//   - refusal: 0-by-ruling (all framework scope/validation refusals →
//     suite-wide hardening park).
//
// Provider guard chain (talent-record is heavier than engagement/submittal):
//   @RequireCapability('ats') — TENANT_ID seeded with the 'ats' entitlement;
//   @RequireScopes('talent:read'/'create'/'edit') — added to the recruiter JWT;
//   @RequireSiteMatch() — passes unconstrained (tenant-wide principal, no
//   site_id claim).

const provider = makeAtsWebProvider();

const TALENT_ID = '00000000-0000-7000-8000-7a0000000001';
const CREATE_BODY = { first_name: 'Grace', last_name: 'Hopper' };
const UPDATE_BODY = { is_hot: true };

// Faithful core of TalentRecordView (Pact tolerates the provider's fuller
// row + the apps/api enrichment interceptor's extra fields). We pin the
// identity + timestamps + the two non-null booleans.
function talentRecordView(
  id: string | undefined,
  opts: { firstName?: string; lastName?: string; isHot?: boolean } = {},
) {
  return {
    id: id === undefined ? uuid() : uuid(id),
    tenant_id: uuid(TENANT_ID),
    site_id: null,
    first_name: like(opts.firstName ?? 'Ada'),
    last_name: like(opts.lastName ?? 'Lovelace'),
    can_relocate: like(false),
    is_hot: opts.isHot === undefined ? like(false) : opts.isHot,
    created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
    updated_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
  };
}

// ======================================================================
// GET /v1/talent-records — happy (list; pool-open, items envelope)
// ======================================================================
describe('ats-web → GET /v1/talent-records', () => {
  it('returns 200 with the tenant talent list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a talent record exist')
      .uponReceiving('a talent-records list read')
      .withRequest('GET', '/v1/talent-records', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: [talentRecordView(TALENT_ID)] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-records`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: Array<{ id: string }> };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });

  // Paged/faceted search path (?paged=true). Pins the live-record filter
  // (a listed/searched record is always record_status='live') + the
  // TalentSearchPage envelope. No ?q=, so talent:search scope isn't required.
  it('returns 200 TalentSearchPage of live records for the paged search', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a talent record exist')
      .uponReceiving('a paged talent-records search')
      .withRequest('GET', '/v1/talent-records', (b) => {
        b.query({ paged: 'true' }).headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: [talentRecordView(TALENT_ID)],
          next_cursor: null,
          facets: {
            availability: like([]),
            engagement: like([]),
            source: like([]),
            hot: like(0),
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-records?paged=true`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          items: unknown[];
          next_cursor: string | null;
          facets: { hot: number };
        };
        expect(body.items.length).toBeGreaterThan(0);
        expect(body.next_cursor).toBeNull();
      });
  });
});

// ======================================================================
// POST /v1/talent-records — happy (create; 201)
// ======================================================================
describe('ats-web → POST /v1/talent-records', () => {
  it('returns 201 with the created talent record', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter can create talent records')
      .uponReceiving('a talent-record create')
      .withRequest('POST', '/v1/talent-records', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          CREATE_BODY,
        );
      })
      .willRespondWith(201, (b) => {
        b.jsonBody(talentRecordView(undefined, { firstName: 'Grace', lastName: 'Hopper' }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-records`, {
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
// PATCH /v1/talent-records/:id — happy (update; 200)
// ======================================================================
describe('ats-web → PATCH /v1/talent-records/:id', () => {
  it('returns 200 with the updated talent record', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a talent record exist')
      .uponReceiving('a talent-record update')
      .withRequest('PATCH', `/v1/talent-records/${TALENT_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          UPDATE_BODY,
        );
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(talentRecordView(TALENT_ID, { isHot: true }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-records/${TALENT_ID}`, {
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
