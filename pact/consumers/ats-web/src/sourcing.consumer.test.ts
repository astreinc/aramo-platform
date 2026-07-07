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

// PC-4b — Pact consumer for ats-web, sourcing domain (post-B3). The sourcing
// pool + promote (create-or-reconcile) surface PC-4 deferred; now settled.
// Merges into ats-web-aramo-core.json.
//
// Scope (PC-4b Directive §1/§3 + Gate-5 ruling): 6 interactions —
//   - GET /v1/sourcing/pool (PoolPage: one sourced subject + bands);
//   - GET /v1/sourcing/pool/:subjectId (SubjectDetail: bands + evidence + refs
//     + PENDING open_identity_advisories);
//   - POST /v1/sourcing/pipeline -> 'promoted' (FRESH MINT, 200);
//   - POST /v1/sourcing/pipeline -> 'already_promoted' (idempotent, 200);
//   - POST /v1/sourcing/bench -> 'promoted' (200);
//   - POST /v1/sourcing/pipeline -> 'deferred_unresolved_identity' (the
//     advisory gate's by-design 200 outcome — a PENDING advisory blocks the
//     mint; the create-or-reconcile business invariant).
//
// All POSTs are 200 (deferrals are expected outcomes, not throws). illegal-
// state: 0-by-substrate. idempotency: 0-by-substrate (no Idempotency-Key).
// Vocabulary: trust bands are PresentationBand (NOT_ESTABLISHED..AUTHORITATIVE);
// no scoring vocab. EvidenceRecord.strength NOT pinned (cycle-law-5 — FE does
// not consume it; wire-exposure routed to PO as product).
//
// Guard chain: @RequireCapability('core') + @RequireScopes('talent:source').

const provider = makeAtsWebProvider();

const POOL_SUBJECT_ID = '00000000-0000-7000-8000-5b1000000001';
const MINT_ARRIVAL_ID = '00000000-0000-7000-8000-a44000000001';
const PROMOTED_ARRIVAL_ID = '00000000-0000-7000-8000-a44000000002';
const PROMOTED_TALENT_ID = '00000000-0000-7000-8000-7a0000000013';
const DEFER_ARRIVAL_ID = '00000000-0000-7000-8000-a44000000003';
const REQ_ID = '00000000-0000-7000-8000-4e9300000001';

// ======================================================================
// GET /v1/sourcing/pool — happy
// ======================================================================
describe('ats-web → GET /v1/sourcing/pool', () => {
  it('returns 200 PoolPage with a sourced subject and trust bands', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a sourced subject with trust and a pending advisory exist')
      .uponReceiving('a sourcing pool read')
      .withRequest('GET', '/v1/sourcing/pool', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: [
            {
              subject_id: uuid(POOL_SUBJECT_ID),
              display_name: like('Grace Hopper'),
              email: like('grace@example.com'),
              trust_bands: {
                identity: like('CORROBORATED'),
                claims: like('SELF_ASSERTED'),
                continuity: like('NOT_ESTABLISHED'),
                eligibility: like('NOT_ESTABLISHED'),
              },
              open_contradiction_count: like(0),
            },
          ],
          next_cursor: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sourcing/pool`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[]; next_cursor: string | null };
        expect(body.items.length).toBeGreaterThan(0);
        expect(body.next_cursor).toBeNull();
      });
  });
});

// ======================================================================
// GET /v1/sourcing/pool/:subjectId — happy
// ======================================================================
describe('ats-web → GET /v1/sourcing/pool/:subjectId', () => {
  it('returns 200 SubjectDetail with bands, evidence, refs, open advisories', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a sourced subject with trust and a pending advisory exist')
      .uponReceiving('a sourcing subject-detail read')
      .withRequest('GET', `/v1/sourcing/pool/${POOL_SUBJECT_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          subject_id: uuid(POOL_SUBJECT_ID),
          display_name: like('Grace Hopper'),
          email: like('grace@example.com'),
          trust_bands: {
            identity: like('CORROBORATED'),
            claims: like('SELF_ASSERTED'),
            continuity: like('NOT_ESTABLISHED'),
            eligibility: like('NOT_ESTABLISHED'),
          },
          open_contradiction_count: like(0),
          evidence: like([]),
          refs: like([]),
          open_identity_advisories: like([]),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sourcing/pool/${POOL_SUBJECT_ID}`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { subject_id: string };
        expect(body.subject_id).toBe(POOL_SUBJECT_ID);
      });
  });
});

// ======================================================================
// POST /v1/sourcing/pipeline — promoted (fresh mint) / already_promoted / defer
// ======================================================================
describe('ats-web → POST /v1/sourcing/pipeline', () => {
  it('returns 200 promoted with talent_record_id + pipeline_id (fresh mint)', async () => {
    const BODY = { ref_type: 'SOURCED_TALENT', ref_id: MINT_ARRIVAL_ID, requisition_id: REQ_ID };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a promotable sourced subject exist')
      .uponReceiving('a promote-to-pipeline (fresh mint)')
      .withRequest('POST', '/v1/sourcing/pipeline', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ status: 'promoted', talent_record_id: uuid(), pipeline_id: uuid() });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sourcing/pipeline`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; talent_record_id: string };
        expect(body.status).toBe('promoted');
        expect(body.talent_record_id).toBeTruthy();
      });
  });

  it('returns 200 already_promoted for a previously-promoted subject', async () => {
    const BODY = { ref_type: 'SOURCED_TALENT', ref_id: PROMOTED_ARRIVAL_ID, requisition_id: REQ_ID };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an already-promoted sourced subject exist')
      .uponReceiving('a promote-to-pipeline (already promoted)')
      .withRequest('POST', '/v1/sourcing/pipeline', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          status: 'already_promoted',
          talent_record_id: uuid(PROMOTED_TALENT_ID),
          pipeline_id: uuid(),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sourcing/pipeline`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string };
        expect(body.status).toBe('already_promoted');
      });
  });

  it('returns 200 deferred_unresolved_identity when a PENDING advisory blocks the mint', async () => {
    const BODY = { ref_type: 'SOURCED_TALENT', ref_id: DEFER_ARRIVAL_ID, requisition_id: REQ_ID };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a sourced subject with a pending identity advisory exist')
      .uponReceiving('a promote-to-pipeline blocked by the advisory gate')
      .withRequest('POST', '/v1/sourcing/pipeline', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ status: 'deferred_unresolved_identity' });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sourcing/pipeline`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string };
        expect(body.status).toBe('deferred_unresolved_identity');
      });
  });
});

// ======================================================================
// POST /v1/sourcing/bench — promoted
// ======================================================================
describe('ats-web → POST /v1/sourcing/bench', () => {
  it('returns 200 promoted with talent_record_id + bench_id', async () => {
    const BODY = { ref_type: 'SOURCED_TALENT', ref_id: MINT_ARRIVAL_ID };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a promotable sourced subject exist')
      .uponReceiving('a promote-to-bench (fresh mint)')
      .withRequest('POST', '/v1/sourcing/bench', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ status: 'promoted', talent_record_id: uuid(), bench_id: uuid() });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/sourcing/bench`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; bench_id: string };
        expect(body.status).toBe('promoted');
        expect(body.bench_id).toBeTruthy();
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
