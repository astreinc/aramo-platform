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

// PC-5d — Pact consumer for ats-web, task domain (Gate-2a desk, part 4 —
// FINAL increment). Merges into ats-web-aramo-core.json.
//
// Scope (PC-5 Directive §3 + Gate-5 ruling): 4 happy interactions —
//   - GET /v1/tasks (my-tasks, bare — keyed to the authenticated recruiter);
//   - POST /v1/tasks (create, 201);
//   - PATCH /v1/tasks/:id (status -> done, 200);
//   - DELETE /v1/tasks/:id (204).
//
// illegal-state: 0-by-substrate (task status is a stored enum; PATCH sets it
//   directly, no from->to transition rules).
// idempotency: 0-by-substrate (no Idempotency-Key).
// refusal: 0-by-ruling (owner-pair / bad-owner_type / vocab 422s are refusals
//   for params the FE constrains -> hardening park; GET /v1/tasks/:id is
//   EXCLUDE-R2, no ats-web call site).
//
// Provider guard chain: @RequireCapability('ats') + @RequireScopes
// (task:read/write) + @RequireSiteMatch(). Task visibility resolvers
// short-circuit to zero reads under company:read:all / requisition:read:all;
// the seeded task's assignee_id = the recruiter so the my-tasks list returns
// it.

const provider = makeAtsWebProvider();

const TASK_ID = '00000000-0000-7000-8000-7a5c00000001';
const TASK_OWNER_REQ_ID = '00000000-0000-7000-8000-4e9200000001';

function taskView(id: string | undefined, opts: { title?: string; status?: string } = {}) {
  return {
    id: id === undefined ? uuid() : uuid(id),
    tenant_id: uuid(TENANT_ID),
    title: like(opts.title ?? 'Call the lead'),
    status: opts.status ?? like('open'),
    source: like('manual'),
    created_by_user_id: like('00000000-0000-0000-0000-0000000000bb'),
    owner_type: like('requisition'),
    owner_id: uuid(TASK_OWNER_REQ_ID),
    created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
    updated_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
  };
}

// ======================================================================
// GET /v1/tasks — happy (my-tasks)
// ======================================================================
describe('ats-web → GET /v1/tasks', () => {
  it('returns 200 with the recruiter my-tasks list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a task exist')
      .uponReceiving('a my-tasks list read')
      .withRequest('GET', '/v1/tasks', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: [taskView(TASK_ID)] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tasks`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });
});

// ======================================================================
// POST /v1/tasks — happy (create; 201)
// ======================================================================
describe('ats-web → POST /v1/tasks', () => {
  it('returns 201 with the created task', async () => {
    const CREATE_BODY = {
      title: 'Prep the brief',
      owner_type: 'requisition',
      owner_id: TASK_OWNER_REQ_ID,
    };
    await provider
      .addInteraction()
      .given('an ats-web recruiter can create tasks')
      .uponReceiving('a task create')
      .withRequest('POST', '/v1/tasks', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          CREATE_BODY,
        );
      })
      .willRespondWith(201, (b) => {
        b.jsonBody(taskView(undefined, { title: 'Prep the brief' }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tasks`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(CREATE_BODY),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { title: string };
        expect(body.title).toBe('Prep the brief');
      });
  });
});

// ======================================================================
// PATCH /v1/tasks/:id — happy (status -> done; 200)
// ======================================================================
describe('ats-web → PATCH /v1/tasks/:id', () => {
  it('returns 200 with the updated task', async () => {
    const UPDATE_BODY = { status: 'done' };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a task exist')
      .uponReceiving('a task update (mark done)')
      .withRequest('PATCH', `/v1/tasks/${TASK_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          UPDATE_BODY,
        );
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(taskView(TASK_ID, { status: 'done' }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tasks/${TASK_ID}`, {
          method: 'PATCH',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(UPDATE_BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string };
        expect(body.status).toBe('done');
      });
  });
});

// ======================================================================
// DELETE /v1/tasks/:id — happy (204)
// ======================================================================
describe('ats-web → DELETE /v1/tasks/:id', () => {
  it('returns 204 on task delete', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a task exist')
      .uponReceiving('a task delete')
      .withRequest('DELETE', `/v1/tasks/${TASK_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(204)
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/tasks/${TASK_ID}`, {
          method: 'DELETE',
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(204);
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
