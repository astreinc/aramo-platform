import { describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  errorBody,
  like,
  makeAtsWebProvider,
  uuid,
} from './support/ats-web-pact.js';

// Track 7 / T7-PX — Pact consumer for the ats-web Contract-to-Permanent conversion command
// (POST /v1/placements/:id/assignment/convert-to-permanent). Merges into ats-web-aramo-core.json.
// Mirrors apps/ats-web/src/placement/placement-api.ts convertAssignmentToPermanent (ONE POST, no
// body). Cookie-auth; the provider requestFilter rewrites the fake cookie to a JWT carrying the
// EXACT conjunction assignment:end + placement:permanent:transition. Convention (placement/
// reporting precedent): 403 authorization refusals are omitted (the client always sends its
// authorized cookie); the governed domain outcomes the client renders (success, replay, 404
// not-convertible, 404 missing governed terms) ARE contracted. Replay + concurrency + the
// same-tx capacity −1/+1 handoff are proven deterministically in the real-PG integration suite.

const provider = makeAtsWebProvider();

const SRC_ID = '00000000-0000-7000-8000-c01200000001';
const SRC_NO_ASSIGN = '00000000-0000-7000-8000-c01200000002';
const SRC_NO_TERMS = '00000000-0000-7000-8000-c01200000003';
const SRC_CONVERTED = '00000000-0000-7000-8000-c01200000004';
const PATH = (id: string) => `/v1/placements/${id}/assignment/convert-to-permanent`;

describe('ats-web → POST /v1/placements/:id/assignment/convert-to-permanent', () => {
  it('returns 200 with the new permanent placement lineage for a convertible placement', async () => {
    await provider
      .addInteraction()
      .given('an ats-web resolver and a convertible contract placement with effective guarantee terms exist')
      .uponReceiving('a contract-to-permanent conversion')
      .withRequest('POST', PATH(SRC_ID), (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
        b.jsonBody({});
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          replayed: like(false),
          source_placement_process_id: uuid(SRC_ID),
          source_contract_assignment_id: uuid('00000000-0000-7000-8000-c0120000a001'),
          target_placement_process_id: uuid('00000000-0000-7000-8000-c0120000b001'),
          target_permanent_placement_id: uuid('00000000-0000-7000-8000-c0120000c001'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${PATH(SRC_ID)}`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { replayed: boolean; target_placement_process_id: string };
        expect(body.replayed).toBe(false);
        expect(typeof body.target_placement_process_id).toBe('string');
      });
  });

  it('returns 200 with replayed=true for an already-converted placement (idempotent)', async () => {
    await provider
      .addInteraction()
      .given('an ats-web resolver and an already-converted contract placement exist')
      .uponReceiving('a repeated contract-to-permanent conversion (replay)')
      .withRequest('POST', PATH(SRC_CONVERTED), (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
        b.jsonBody({});
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          replayed: like(true),
          source_placement_process_id: uuid(SRC_CONVERTED),
          source_contract_assignment_id: uuid('00000000-0000-7000-8000-c0120000a004'),
          target_placement_process_id: uuid('00000000-0000-7000-8000-c0120000b004'),
          target_permanent_placement_id: uuid('00000000-0000-7000-8000-c0120000c004'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${PATH(SRC_CONVERTED)}`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { replayed: boolean };
        expect(body.replayed).toBe(true);
      });
  });

  it('returns 404 when there is no ACTIVE assignment to convert', async () => {
    await provider
      .addInteraction()
      .given('an ats-web resolver and a placement with no active assignment exist')
      .uponReceiving('a conversion of a placement with no active assignment')
      .withRequest('POST', PATH(SRC_NO_ASSIGN), (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
        b.jsonBody({});
      })
      .willRespondWith(404, (b) => {
        b.jsonBody(errorBody('NOT_FOUND', 'No active ContractAssignment to convert'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${PATH(SRC_NO_ASSIGN)}`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('NOT_FOUND');
      });
  });

  it('returns 404 TERMS_NOT_FOUND when no governed guarantee terms are effective', async () => {
    await provider
      .addInteraction()
      .given('an ats-web resolver and a convertible contract placement without guarantee terms exist')
      .uponReceiving('a conversion with no effective guarantee terms')
      .withRequest('POST', PATH(SRC_NO_TERMS), (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
        b.jsonBody({});
      })
      .willRespondWith(404, (b) => {
        b.jsonBody(errorBody('PERMANENT_PLACEMENT_TERMS_NOT_FOUND', 'no guarantee-term version is effective for the requisition at the conversion date'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${PATH(SRC_NO_TERMS)}`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('PERMANENT_PLACEMENT_TERMS_NOT_FOUND');
      });
  });
});
