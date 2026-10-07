import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  ISO_TIMESTAMP,
  TENANT_ID,
  eachLike,
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
// Scope (PC-5 Directive §3 + Gate-5 ruling): 5 interactions —
//   happy (4): GET /v1/pipelines (list), GET /v1/pipelines/:id/history,
//     POST /v1/pipelines (create at no_contact, 201), POST :id/transition
//     (legal no_contact->contacted, 200);
//   illegal-state (1): POST :id/transition no_contact->qualified ->
//     INVALID_PIPELINE_TRANSITION 422 (the client-mirror-drift tripwire —
//     ats-web mirrors LEGAL_TRANSITIONS client-side, so this pins the server
//     truth the mirror must track).
//   (The former over-capacity refusal interaction was RETIRED — see the note
//    at the end of the describe block.)
//
// Recruiting-Journey §14/§27 additions: the transition happy-path is now a recruiter
// DECISION edge (talent_responded->qualifying) and a naked evidence-backed transition is
// a 422 refusal (PIPELINE_STAGE_REQUIRES_EVIDENCE); GET :id/journey is pinned for the
// `recruiting_available_actions` field the FE renders as the sole next-action source.
//
// idempotency: L2-B — POST /v1/pipelines now REQUIRES a UUID Idempotency-Key
//   (the create interaction sends one); the transition + read endpoints remain
//   0-by-substrate.
// EXCLUDE-R2 (no ats-web call site): GET /v1/pipelines/:id. DELETE
//   /v1/pipelines/:id is WITHDRAWN (L2-B — the episode is durable).
//
// Provider guard chain: @RequireCapability('ats') + @RequireScopes
// (pipeline:read/add/change-status) + @RequireSiteMatch(). The visibility
// resolvers short-circuit to zero reads under company:read:all /
// requisition:read:all.

const provider = makeAtsWebProvider();

const PIPE_ID = '00000000-0000-7000-8000-71be00000001';
const PIPE_TALENT_ID = '00000000-0000-7000-8000-7a1e00000001';
const PIPE_REQ_ID = '00000000-0000-7000-8000-4e9100000001';
// TI-1D-D — the resume edition the provider seeds for the pipeline talent.
const PIPE_RE_ED = '00000000-0000-7000-8000-71be000000e1';

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
    // L2-A — optimistic-concurrency token echoed back on the next transition.
    version: like(0),
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
        // Requisition-expander enrichment (LOCKED Aramo-Requisition-Expander-
        // Talent-Rate-Columns v1.0). apps/api composes these five fields onto
        // the LIST read only (never create/transition). The verifying recruiter
        // token holds talent:read (existence gate open) and the state seeds a
        // contacting-granted talent, so all five are disclosed non-null here —
        // verifying the enrichment through the REAL provider surface.
        b.jsonBody({
          items: [
            {
              ...pipelineView(PIPE_ID),
              email: like('dana.rivera@example.com'),
              phone: like('+1-512-555-0101'),
              location: like('Austin, TX'),
              work_auth: like('us_citizen'),
              desired_rate: like('$85/hr'),
            },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/pipelines`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          items: Array<Record<string, unknown>>;
        };
        expect(body.items.length).toBeGreaterThan(0);
        // The enrichment fields are present on the list item.
        expect(body.items[0]).toHaveProperty('email');
        expect(body.items[0]).toHaveProperty('desired_rate');
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
// GET /v1/pipelines/:id/journey — happy (Recruiting-Journey §14/§27)
// ======================================================================
describe('ats-web → GET /v1/pipelines/:id/journey', () => {
  // Recruiting-Journey §14/§27 — the Unified Talent Journey read is the SINGLE source
  // of the recruiting next-action availability. The FE RENDERS `recruiting_available_actions`
  // (owned + derived by the Pipeline/Recruiting domain from the current milestone); it never
  // re-derives availability from stage equality. This pins the new contract field: at the
  // `contacted` milestone the server offers exactly the evidence-recording action
  // `record_talent_response` (never a naked stage write). The provider returns the full
  // composed journey; the consumer asserts only the subset it depends on.
  it('returns 200 exposing recruiting_available_actions for a contacted episode', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a pipeline at contacted exist')
      .uponReceiving('a talent journey read for a contacted episode')
      .withRequest('GET', `/v1/pipelines/${PIPE_ID}/journey`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          requisition_id: uuid(PIPE_REQ_ID),
          talent_record_id: uuid(PIPE_TALENT_ID),
          current_journey_stage: like('CONTACTED'),
          sub_states: {
            // The canonical pipeline milestone the recruiting availability derives from.
            pipeline_stage: like('contacted'),
          },
          // The new canonical field — a non-empty array of the recruiting next-action
          // vocabulary. At `contacted` the sole offered action records response evidence.
          recruiting_available_actions: eachLike('record_talent_response'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/pipelines/${PIPE_ID}/journey`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          recruiting_available_actions: string[];
          sub_states: { pipeline_stage: string };
        };
        expect(Array.isArray(body.recruiting_available_actions)).toBe(true);
        expect(body.recruiting_available_actions).toContain('record_talent_response');
      });
  });
});

// ======================================================================
// POST /v1/pipelines — happy (create at no_contact; 201)
// ======================================================================
describe('ats-web → POST /v1/pipelines', () => {
  it('returns 201 with the created pipeline at no_contact', async () => {
    const BODY = { talent_record_id: PIPE_TALENT_ID, requisition_id: PIPE_REQ_ID };
    // L2-B — a UUID Idempotency-Key is now required on create.
    const IDEMPOTENCY_KEY = '00000000-0000-7000-8000-71be000000ff';
    await provider
      .addInteraction()
      .given('an ats-web recruiter can create pipelines')
      .uponReceiving('a pipeline create')
      .withRequest('POST', '/v1/pipelines', (b) => {
        b.headers({
          Cookie: like(ACCESS_COOKIE),
          'Content-Type': 'application/json',
          'Idempotency-Key': like(IDEMPOTENCY_KEY),
        }).jsonBody(BODY);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody(pipelineView(undefined, { status: 'no_contact' }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/pipelines`, {
          method: 'POST',
          headers: {
            Cookie: ACCESS_COOKIE,
            'Content-Type': 'application/json',
            'Idempotency-Key': IDEMPOTENCY_KEY,
          },
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
  // Recruiting-Journey §17/§27 — the FE's transitionPipeline now carries ONLY the
  // recruiter DECISION edges (qualifying / qualified). The evidence-backed milestones
  // (contacted / talent_responded) are NEVER reached via a naked transition from the
  // FE; they originate from backend evidence authority. This proves the real decision
  // call: a talent_responded episode advances to qualifying.
  it('returns 200 for a legal recruiter DECISION transition (talent_responded -> qualifying)', async () => {
    const BODY = { to_status: 'qualifying', expected_version: 0 };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a pipeline at talent_responded exist')
      .uponReceiving('a legal recruiter decision transition')
      .withRequest('POST', `/v1/pipelines/${PIPE_ID}/transition`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          BODY,
        );
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(pipelineView(PIPE_ID, { status: 'qualifying' }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/pipelines/${PIPE_ID}/transition`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string };
        expect(body.status).toBe('qualifying');
      });
  });

  // Recruiting-Journey I1/§17/§27 — a naked transition into an EVIDENCE-backed milestone
  // is refused in the domain authority (PIPELINE_STAGE_REQUIRES_EVIDENCE, 422). This is
  // the contract-level proof that `contacted` can never be manufactured by a stage click.
  it('returns 422 PIPELINE_STAGE_REQUIRES_EVIDENCE for a naked evidence-backed transition (no_contact -> contacted)', async () => {
    const BODY = { to_status: 'contacted', expected_version: 0 };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a pipeline exist')
      .uponReceiving('a naked evidence-backed transition')
      .withRequest('POST', `/v1/pipelines/${PIPE_ID}/transition`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          BODY,
        );
      })
      .willRespondWith(422, (b) => {
        b.jsonBody(
          errorBody('PIPELINE_STAGE_REQUIRES_EVIDENCE', 'Pipeline milestone is established only from grounded evidence'),
        );
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/pipelines/${PIPE_ID}/transition`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(422);
      });
  });

  // illegal-state — no_contact -> qualified is not in LEGAL_TRANSITIONS (a
  // non-adjacent canonical jump), so it fails the transition-matrix guard.
  it('returns 422 INVALID_PIPELINE_TRANSITION for an illegal transition', async () => {
    const BODY = { to_status: 'qualified', expected_version: 0 };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a pipeline exist')
      .uponReceiving('an illegal pipeline transition (no_contact -> qualified)')
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

  // Track 4 / T4-B2 §7 — the "placing into a full requisition -> 409
  // REQUISITION_NO_OPENINGS" interaction was RETIRED. Pipeline no longer owns
  // requisition capacity: a Pipeline transition never decrements openings and never
  // refuses on over-capacity (over-capacity is a representable DERIVED state, not a
  // pipeline-time gate). The interaction and its provider state are removed from the
  // contract accordingly.
});

// ======================================================================
// TI-1D-D — GET /v1/pipelines/:id/resume-edition (Requisition-context selection)
// ======================================================================
describe('ats-web → GET /v1/pipelines/:id/resume-edition', () => {
  it('returns 200 with the current selection, default, and available editions', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a pipeline with a resume selection exist')
      .uponReceiving('a pipeline resume-edition read')
      .withRequest('GET', `/v1/pipelines/${PIPE_ID}/resume-edition`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          pipeline_id: uuid(PIPE_ID),
          talent_record_id: uuid(PIPE_TALENT_ID),
          requisition_id: uuid(PIPE_REQ_ID),
          selected_edition_id: uuid(PIPE_RE_ED),
          selected_at: regex(ISO_TIMESTAMP, '2026-07-01T00:00:00Z'),
          selected_by: uuid(),
          default_edition_id: uuid(PIPE_RE_ED),
          // Resume Revision Lifecycle §9 — the current selection's lifecycle + the
          // requires-attention flag the requisition panel renders.
          selected_lifecycle_status: like('active'),
          selected_requires_attention: like(false),
          available_editions: [
            {
              edition_id: uuid(PIPE_RE_ED),
              purpose: like('GENERAL'),
              label: null,
              // §3/§5 tailoring context + §2/§10 derived revision ordinal.
              requisition_id: null,
              revision_number: like(1),
              filename: like('dana-general.pdf'),
              mime_type: like('application/pdf'),
              created_at: regex(ISO_TIMESTAMP, '2026-07-01T00:00:00Z'),
              is_default: like(true),
            },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/pipelines/${PIPE_ID}/resume-edition`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          selected_edition_id: string;
          available_editions: unknown[];
        };
        expect(body.selected_edition_id).toBe(PIPE_RE_ED);
        expect(body.available_editions.length).toBeGreaterThan(0);
      });
  });
});

// ======================================================================
// TI-1D-D — PUT /v1/pipelines/:id/resume-edition (explicit selection)
// ======================================================================
describe('ats-web → PUT /v1/pipelines/:id/resume-edition', () => {
  it('returns 200 with the appended working selection', async () => {
    const BODY = { resume_edition_id: PIPE_RE_ED };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a pipeline with a selectable resume edition exist')
      .uponReceiving('a pipeline resume-edition selection')
      .withRequest('PUT', `/v1/pipelines/${PIPE_ID}/resume-edition`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          BODY,
        );
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          pipeline_id: uuid(PIPE_ID),
          talent_record_id: uuid(PIPE_TALENT_ID),
          requisition_id: uuid(PIPE_REQ_ID),
          selected_edition_id: uuid(PIPE_RE_ED),
          selected_at: regex(ISO_TIMESTAMP, '2026-07-01T00:00:00Z'),
          selected_by: uuid(),
          default_edition_id: null,
          available_editions: [
            {
              edition_id: uuid(PIPE_RE_ED),
              purpose: like('GENERAL'),
              label: null,
              filename: like('dana-general.pdf'),
              mime_type: like('application/pdf'),
              created_at: regex(ISO_TIMESTAMP, '2026-07-01T00:00:00Z'),
              is_default: like(false),
            },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/pipelines/${PIPE_ID}/resume-edition`, {
          method: 'PUT',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { selected_edition_id: string };
        expect(body.selected_edition_id).toBe(PIPE_RE_ED);
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
