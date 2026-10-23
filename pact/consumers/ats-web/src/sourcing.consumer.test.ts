import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  ISO_TIMESTAMP,
  eachLike,
  like,
  makeAtsWebProvider,
  regex,
  uuid,
} from './support/ats-web-pact.js';

// PC-4b → ATI-SEP-1 T10 WP2 (Addenda A2 F-1 / A3) — Pact consumer for ats-web,
// sourcing domain. Sourcing runs on ATS data only: the pool is the tenant's
// un-promoted sourced_talent arrivals, promotion mints an ATS TalentRecord from an
// arrival behind the ATS duplicate-advisory gate. Merges into ats-web-aramo-core.json.
//
// Scope: 6 interactions —
//   - GET /v1/sourcing/pool (PoolPage: one arrival + pending-advisory count);
//   - GET /v1/sourcing/pool/:subjectId (the arrival drill-in: refs + PENDING
//     open_identity_advisories);
//   - POST /v1/sourcing/pipeline -> 'promoted' (FRESH MINT, 200);
//   - POST /v1/sourcing/pipeline -> 'already_promoted' (idempotent, 200);
//   - POST /v1/sourcing/bench -> 'promoted' (200);
//   - POST /v1/sourcing/pipeline -> 'deferred_unresolved_identity' (a PENDING
//     duplicate advisory blocks the mint — an expected 200 outcome).
//
// Wire note: `subject_id` keeps its name and carries the SourcedTalent id (the
// drill-in param + the SOURCED_TALENT ref_id). The retired trust fields are gone;
// no trust or numeric signal is pinned. Guard chain: @RequireCapability('core') +
// @RequireScopes('talent:source').

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
  it('returns 200 PoolPage with a sourced arrival', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a sourced arrival with a pending duplicate advisory exist')
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
              phone: like('+15125550101'),
              source_channel: like('manual_capture'),
              arrived_at: regex(ISO_TIMESTAMP, '2026-07-01T00:00:00.000Z'),
              open_advisory_count: like(1),
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
  it('returns 200 the arrival drill-in with refs and open duplicate advisories', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a sourced arrival with a pending duplicate advisory exist')
      .uponReceiving('a sourcing subject-detail read')
      .withRequest('GET', `/v1/sourcing/pool/${POOL_SUBJECT_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          subject_id: uuid(POOL_SUBJECT_ID),
          display_name: like('Grace Hopper'),
          email: like('grace@example.com'),
          phone: like('+15125550101'),
          source_channel: like('manual_capture'),
          arrived_at: regex(ISO_TIMESTAMP, '2026-07-01T00:00:00.000Z'),
          refs: eachLike({
            ref_type: like('SOURCED_TALENT'),
            ref_id: uuid(POOL_SUBJECT_ID),
            link_source: like('manual_capture'),
          }),
          open_identity_advisories: eachLike({
            id: uuid(),
            talent_record_id: uuid(),
            talent_record_name: like('Grace Hopper'),
            basis: like('SOURCED_ARRIVAL'),
            shared_kinds: like(['EMAIL']),
            status: 'PENDING_REVIEW',
            created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00.000Z'),
          }),
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
      .given('an ats-web recruiter and a promotable sourced arrival exist')
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

  it('returns 200 already_promoted for a previously-promoted arrival', async () => {
    const BODY = { ref_type: 'SOURCED_TALENT', ref_id: PROMOTED_ARRIVAL_ID, requisition_id: REQ_ID };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an already-promoted sourced arrival exist')
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

  it('returns 200 deferred_unresolved_identity when a PENDING duplicate advisory blocks the mint', async () => {
    const BODY = { ref_type: 'SOURCED_TALENT', ref_id: DEFER_ARRIVAL_ID, requisition_id: REQ_ID };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a sourced arrival with a pending duplicate advisory blocking promotion exist')
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
      .given('an ats-web recruiter and a promotable sourced arrival exist')
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
