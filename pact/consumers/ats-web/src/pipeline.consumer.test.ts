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

// PC-5c — Pact consumer for ats-web, pipeline domain (Gate-2a desk, part 3).
// The requisition pipeline funnel + its state machine (the desk's ONLY state
// machine — interviews/offers/placements are pipeline stages, not endpoints).
// Merges into ats-web-aramo-core.json.
//
// Scope (PC-5 Directive §3 + Gate-5 ruling): 6 interactions —
//   happy (4): GET /v1/pipelines (list), GET /v1/pipelines/:id/history,
//     POST /v1/pipelines (create at no_contact, 201), POST :id/transition
//     (legal no_contact->contacted, 200);
//   illegal-state (1): POST :id/transition no_contact->placed ->
//     INVALID_PIPELINE_TRANSITION 422 (the client-mirror-drift tripwire —
//     ats-web mirrors LEGAL_TRANSITIONS client-side, so this pins the server
//     truth the mirror must track);
//   refusal (1): POST :id/transition offered->placed when the requisition has
//     no available openings -> REQUISITION_NO_OPENINGS 409 (the consumer sends
//     a LEGAL transition but cannot predict server-side capacity).
//
// idempotency: 0-by-substrate (no Idempotency-Key on any pipeline endpoint).
// EXCLUDE-R2 (no ats-web call site): GET /v1/pipelines/:id, DELETE
//   /v1/pipelines/:id.
//
// Provider guard chain: @RequireCapability('ats') + @RequireScopes
// (pipeline:read/add/change-status) + @RequireSiteMatch(). The visibility
// resolvers short-circuit to zero reads under company:read:all /
// requisition:read:all.

const provider = makeAtsWebProvider();

const PIPE_ID = '00000000-0000-7000-8000-71be00000001';
const PIPE_OFFERED_ID = '00000000-0000-7000-8000-71be00000002';
const PIPE_TALENT_ID = '00000000-0000-7000-8000-7a1e00000001';
const PIPE_REQ_ID = '00000000-0000-7000-8000-4e9100000001';

function pipelineView(
  id: string | undefined,
  opts: { status?: string; talentRecordId?: string; requisitionId?: string } = {},
) {
  return {
    id: id === undefined ? uuid() : uuid(id),
    tenant_id: uuid(TENANT_ID),
    site_id: null,
    talent_record_id: uuid(opts.talentRecordId ?? PIPE_TALENT_ID),
    requisition_id: uuid(opts.requisitionId ?? PIPE_REQ_ID),
    status: opts.status ?? like('no_contact'),
    created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
    updated_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
  };
}

// ======================================================================
// GET /v1/pipelines — happy (list)
// ======================================================================
describe('ats-web → GET /v1/pipelines', () => {
  it('returns 200 with the pipeline list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a pipeline exist')
      .uponReceiving('a pipelines list read')
      .withRequest('GET', '/v1/pipelines', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: [pipelineView(PIPE_ID)] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/pipelines`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });
});

// ======================================================================
// GET /v1/pipelines/:id/history — happy
// ======================================================================
describe('ats-web → GET /v1/pipelines/:id/history', () => {
  it('returns 200 with the status-history list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a pipeline with a status history entry exist')
      .uponReceiving('a pipeline history read')
      .withRequest('GET', `/v1/pipelines/${PIPE_ID}/history`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: [
            {
              id: uuid(),
              tenant_id: uuid(TENANT_ID),
              pipeline_id: uuid(PIPE_ID),
              status_from: like('no_contact'),
              status_to: like('contacted'),
              changed_by_id: null,
              changed_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
              note: null,
            },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/pipelines/${PIPE_ID}/history`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });
});

// ======================================================================
// POST /v1/pipelines — happy (create at no_contact; 201)
// ======================================================================
describe('ats-web → POST /v1/pipelines', () => {
  it('returns 201 with the created pipeline at no_contact', async () => {
    const BODY = { talent_record_id: PIPE_TALENT_ID, requisition_id: PIPE_REQ_ID };
    await provider
      .addInteraction()
      .given('an ats-web recruiter can create pipelines')
      .uponReceiving('a pipeline create')
      .withRequest('POST', '/v1/pipelines', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          BODY,
        );
      })
      .willRespondWith(201, (b) => {
        b.jsonBody(pipelineView(undefined, { status: 'no_contact' }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/pipelines`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { status: string };
        expect(body.status).toBe('no_contact');
      });
  });
});

// ======================================================================
// POST /v1/pipelines/:id/transition — happy + illegal-state + refusal
// ======================================================================
describe('ats-web → POST /v1/pipelines/:id/transition', () => {
  it('returns 200 for a legal transition (no_contact -> contacted)', async () => {
    const BODY = { to_status: 'contacted' };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a pipeline exist')
      .uponReceiving('a legal pipeline transition')
      .withRequest('POST', `/v1/pipelines/${PIPE_ID}/transition`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          BODY,
        );
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(pipelineView(PIPE_ID, { status: 'contacted' }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/pipelines/${PIPE_ID}/transition`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string };
        expect(body.status).toBe('contacted');
      });
  });

  // illegal-state — no_contact -> placed is not in LEGAL_TRANSITIONS.
  it('returns 422 INVALID_PIPELINE_TRANSITION for an illegal transition', async () => {
    const BODY = { to_status: 'placed' };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a pipeline exist')
      .uponReceiving('an illegal pipeline transition (no_contact -> placed)')
      .withRequest('POST', `/v1/pipelines/${PIPE_ID}/transition`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          BODY,
        );
      })
      .willRespondWith(422, (b) => {
        b.jsonBody(
          errorBody('INVALID_PIPELINE_TRANSITION', 'Illegal pipeline transition'),
        );
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/pipelines/${PIPE_ID}/transition`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('INVALID_PIPELINE_TRANSITION');
      });
  });

  // refusal — offered -> placed is legal, but the requisition has no openings.
  it('returns 409 REQUISITION_NO_OPENINGS when placing into a full requisition', async () => {
    const BODY = { to_status: 'placed' };
    await provider
      .addInteraction()
      .given(
        'an ats-web recruiter and a pipeline in offered state with no requisition openings exist',
      )
      .uponReceiving('a placement transition into a full requisition')
      .withRequest('POST', `/v1/pipelines/${PIPE_OFFERED_ID}/transition`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          BODY,
        );
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(
          errorBody('REQUISITION_NO_OPENINGS', 'Requisition has no available openings for placement'),
        );
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/pipelines/${PIPE_OFFERED_ID}/transition`,
          {
            method: 'POST',
            headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
            body: JSON.stringify(BODY),
          },
        );
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('REQUISITION_NO_OPENINGS');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
