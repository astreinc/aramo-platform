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

// PC-5a — Pact consumer for ats-web, D4a assignment/ownership domain (Gate-2a
// desk, part 2). The two authorization axes recruiters wire on the account
// hub: direct user→company assignments (company:assign) and pod→client team
// ownerships (team:manage). Merges into ats-web-aramo-core.json.
//
// Scope (PC-5 Directive §3 + Gate-5 ruling): 7 happy interactions —
//   - GET /v1/companies/:companyId/assignments ({items});
//   - GET /v1/companies/:companyId/team ({owner_id, member_user_ids});
//   - POST /v1/companies/:companyId/assignments (201, 3-key projection);
//   - DELETE /v1/companies/:companyId/assignments/:userId (204);
//   - GET /v1/teams/:teamId/clients ({items});
//   - POST /v1/teams/:teamId/clients (201, 3-key projection);
//   - DELETE /v1/teams/:teamId/clients/:companyId (204).
//
// illegal-state: 0-by-substrate (D4a is idempotent CRUD — silent no-op on
//   re-assign, no transition surface).
// idempotency: 0-by-substrate (no Idempotency-Key).
// refusal: 0-by-ruling (NOT_FOUND on absent parent company → hardening park).
//
// The two POST responses are deliberate 3-key projections (id + the two edge
// endpoints), NOT the full row — so tenant_id/assigned_at/assigned_by_id are
// asserted only on the GET list items. The D4a writes emit best-effort
// IdentityAuditService events (swallowed when the identity audit table is
// absent), so no identity migration is needed provider-side.

const provider = makeAtsWebProvider();

const COMPANY_ID = '00000000-0000-7000-8000-c00000000001';
const ASSIGN_USER_ID = '00000000-0000-7000-8000-115e00000001';
const TEAM_ID = '00000000-0000-7000-8000-7ea000000001';
const ASSIGNMENT_ID = '00000000-0000-7000-8000-a55160000001';
const OWNERSHIP_ID = '00000000-0000-7000-8000-04e160000001';

// ======================================================================
// Direct-assignment axis (company:assign)
// ======================================================================
describe('ats-web → company assignments', () => {
  it('returns 200 with the company assignment list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a company with a user assignment exist')
      .uponReceiving('a company assignments list read')
      .withRequest('GET', `/v1/companies/${COMPANY_ID}/assignments`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: [
            {
              id: uuid(ASSIGNMENT_ID),
              tenant_id: uuid(TENANT_ID),
              user_id: uuid(ASSIGN_USER_ID),
              company_id: uuid(COMPANY_ID),
              assigned_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
              assigned_by_id: null,
            },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/companies/${COMPANY_ID}/assignments`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });

  it('returns 200 with the account team', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a company with a user assignment exist')
      .uponReceiving('a company team read')
      .withRequest('GET', `/v1/companies/${COMPANY_ID}/team`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          owner_id: null,
          member_user_ids: like([ASSIGN_USER_ID]),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/companies/${COMPANY_ID}/team`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { member_user_ids: string[] };
        expect(Array.isArray(body.member_user_ids)).toBe(true);
      });
  });

  it('returns 201 with the created assignment (3-key projection)', async () => {
    const BODY = { user_id: ASSIGN_USER_ID };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a company exist')
      .uponReceiving('a company assignment create')
      .withRequest('POST', `/v1/companies/${COMPANY_ID}/assignments`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          BODY,
        );
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          id: uuid(),
          user_id: uuid(ASSIGN_USER_ID),
          company_id: uuid(COMPANY_ID),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/companies/${COMPANY_ID}/assignments`,
          {
            method: 'POST',
            headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
            body: JSON.stringify(BODY),
          },
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as { company_id: string };
        expect(body.company_id).toBe(COMPANY_ID);
      });
  });

  it('returns 204 on assignment delete', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a company with a user assignment exist')
      .uponReceiving('a company assignment delete')
      .withRequest(
        'DELETE',
        `/v1/companies/${COMPANY_ID}/assignments/${ASSIGN_USER_ID}`,
        (b) => {
          b.headers({ Cookie: like(ACCESS_COOKIE) });
        },
      )
      .willRespondWith(204)
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/companies/${COMPANY_ID}/assignments/${ASSIGN_USER_ID}`,
          { method: 'DELETE', headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(204);
      });
  });
});

// ======================================================================
// Axis-2 team client-ownership (team:manage)
// ======================================================================
describe('ats-web → team client ownership', () => {
  it('returns 200 with the team client list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a team with a client ownership exist')
      .uponReceiving('a team clients list read')
      .withRequest('GET', `/v1/teams/${TEAM_ID}/clients`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: [
            {
              id: uuid(OWNERSHIP_ID),
              tenant_id: uuid(TENANT_ID),
              team_id: uuid(TEAM_ID),
              company_id: uuid(COMPANY_ID),
              assigned_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
              assigned_by_id: null,
            },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/teams/${TEAM_ID}/clients`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });

  it('returns 201 with the created ownership (3-key projection)', async () => {
    const BODY = { company_id: COMPANY_ID };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a company exist')
      .uponReceiving('a team client ownership create')
      .withRequest('POST', `/v1/teams/${TEAM_ID}/clients`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          BODY,
        );
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          id: uuid(),
          team_id: uuid(TEAM_ID),
          company_id: uuid(COMPANY_ID),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/teams/${TEAM_ID}/clients`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { team_id: string };
        expect(body.team_id).toBe(TEAM_ID);
      });
  });

  it('returns 204 on ownership delete', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a team with a client ownership exist')
      .uponReceiving('a team client ownership delete')
      .withRequest(
        'DELETE',
        `/v1/teams/${TEAM_ID}/clients/${COMPANY_ID}`,
        (b) => {
          b.headers({ Cookie: like(ACCESS_COOKIE) });
        },
      )
      .willRespondWith(204)
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/teams/${TEAM_ID}/clients/${COMPANY_ID}`,
          { method: 'DELETE', headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(204);
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
