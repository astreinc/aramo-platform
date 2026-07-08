import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

// PC-7c — ats-web management edges + teams (identity-admin, pure-DB).
// @RequireCapability('ats') + org:manage (edges) / team:manage (teams).
// idempotency 0-by-substrate; edges + team-members are BE-idempotent by
// natural key (dup → existing row, 201). refusal CONTRACT: edge self_loop
// 409, team duplicate-name 400.

const provider = makeAtsWebProvider();

const USER_A = '00000000-0000-7000-8000-05e100000001';
const USER_B = '00000000-0000-7000-8000-05e100000002';
const TEAM_ID = '00000000-0000-7000-8000-77ea00000001';
const EDGE_ID = '00000000-0000-7000-8000-ed6e00000001';

describe('ats-web → management edges', () => {
  it('GET /v1/management/edges returns the edge list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web admin and a management edge exist')
      .uponReceiving('a management edges list read')
      .withRequest('GET', '/v1/management/edges', (b) => { b.headers({ Cookie: like(ACCESS_COOKIE) }); })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: [
            {
              id: uuid(EDGE_ID),
              tenant_id: uuid(TENANT_ID),
              manager_user_id: uuid(USER_A),
              report_user_id: uuid(USER_B),
              created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
              created_by_id: null,
            },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/management/edges`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });

  it('POST /v1/management/edges creates an edge (201)', async () => {
    const BODY = { manager_user_id: USER_A, report_user_id: USER_B };
    await provider
      .addInteraction()
      .given('an ats-web admin and two users exist')
      .uponReceiving('a management edge create')
      .withRequest('POST', '/v1/management/edges', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({ id: uuid(), manager_user_id: uuid(USER_A), report_user_id: uuid(USER_B) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/management/edges`, {
          method: 'POST', headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' }, body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(201);
      });
  });

  it('POST /v1/management/edges is idempotent on a duplicate pair (201 existing)', async () => {
    const BODY = { manager_user_id: USER_A, report_user_id: USER_B };
    await provider
      .addInteraction()
      .given('an ats-web admin and a management edge exist')
      .uponReceiving('a duplicate management edge create')
      .withRequest('POST', '/v1/management/edges', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({ id: uuid(EDGE_ID), manager_user_id: uuid(USER_A), report_user_id: uuid(USER_B) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/management/edges`, {
          method: 'POST', headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' }, body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(201);
      });
  });

  it('POST /v1/management/edges self-loop returns 409', async () => {
    const BODY = { manager_user_id: USER_A, report_user_id: USER_A };
    await provider
      .addInteraction()
      .given('an ats-web admin and two users exist')
      .uponReceiving('a self-loop management edge create')
      .withRequest('POST', '/v1/management/edges', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(409, (b) => { b.jsonBody(errorBody('MANAGEMENT_CYCLE_REJECTED', 'a user cannot manage themselves')); })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/management/edges`, {
          method: 'POST', headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' }, body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(409);
      });
  });

  it('DELETE /v1/management/edges/:id returns 204', async () => {
    await provider
      .addInteraction()
      .given('an ats-web admin and a management edge exist')
      .uponReceiving('a management edge delete')
      .withRequest('DELETE', `/v1/management/edges/${EDGE_ID}`, (b) => { b.headers({ Cookie: like(ACCESS_COOKIE) }); })
      .willRespondWith(204)
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/management/edges/${EDGE_ID}`, { method: 'DELETE', headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(204);
      });
  });
});

describe('ats-web → teams', () => {
  it('GET /v1/teams returns the team list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web admin and a team exist')
      .uponReceiving('a teams list read')
      .withRequest('GET', '/v1/teams', (b) => { b.headers({ Cookie: like(ACCESS_COOKIE) }); })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: [
            {
              id: uuid(TEAM_ID),
              tenant_id: uuid(TENANT_ID),
              name: like('Alpha Pod'),
              owner_user_id: uuid(USER_A),
              is_active: like(true),
              created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
              updated_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
            },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/teams`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });

  it('POST /v1/teams creates a team (201)', async () => {
    const BODY = { name: 'Bravo Pod', owner_user_id: USER_A };
    await provider
      .addInteraction()
      .given('an ats-web admin and two users exist')
      .uponReceiving('a team create')
      .withRequest('POST', '/v1/teams', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({ id: uuid(), name: like('Bravo Pod'), owner_user_id: uuid(USER_A), is_active: like(true) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/teams`, {
          method: 'POST', headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' }, body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(201);
      });
  });

  it('POST /v1/teams with a duplicate name returns 400', async () => {
    const BODY = { name: 'Alpha Pod', owner_user_id: USER_A };
    await provider
      .addInteraction()
      .given('an ats-web admin and a team exist')
      .uponReceiving('a team create with a duplicate name')
      .withRequest('POST', '/v1/teams', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(400, (b) => { b.jsonBody(errorBody('VALIDATION_ERROR', 'a team with that name already exists')); })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/teams`, {
          method: 'POST', headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' }, body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(400);
      });
  });

  it('GET /v1/teams/:id/members returns the member list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web admin and a team with a member exist')
      .uponReceiving('a team members list read')
      .withRequest('GET', `/v1/teams/${TEAM_ID}/members`, (b) => { b.headers({ Cookie: like(ACCESS_COOKIE) }); })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: [
            {
              id: uuid(),
              tenant_id: uuid(TENANT_ID),
              team_id: uuid(TEAM_ID),
              user_id: uuid(USER_B),
              added_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
              added_by_id: null,
            },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/teams/${TEAM_ID}/members`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });

  it('POST /v1/teams/:id/members adds a member (201)', async () => {
    const BODY = { user_id: USER_B };
    await provider
      .addInteraction()
      .given('an ats-web admin and a team exist')
      .uponReceiving('a team member add')
      .withRequest('POST', `/v1/teams/${TEAM_ID}/members`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({ id: uuid(), team_id: uuid(TEAM_ID), user_id: uuid(USER_B) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/teams/${TEAM_ID}/members`, {
          method: 'POST', headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' }, body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(201);
      });
  });

  it('DELETE /v1/teams/:id/members/:userId returns 204', async () => {
    await provider
      .addInteraction()
      .given('an ats-web admin and a team with a member exist')
      .uponReceiving('a team member remove')
      .withRequest('DELETE', `/v1/teams/${TEAM_ID}/members/${USER_B}`, (b) => { b.headers({ Cookie: like(ACCESS_COOKIE) }); })
      .willRespondWith(204)
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/teams/${TEAM_ID}/members/${USER_B}`, { method: 'DELETE', headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(204);
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
