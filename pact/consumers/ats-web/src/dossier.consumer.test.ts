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

// TR-14 B2 → ATI-SEP-1 T10 WP3b — Pact consumer for ats-web, the trust dossier
// domain. The dossier is now a read-only PRESENTATION of Talent Intelligence's
// tenant view of the record (TI owns trust; ADR-0036). ENRICHMENT ONLY: every
// read carries `intelligence_status` (ENABLED | NOT_ENTITLED | NOT_CONFIGURED |
// UNAVAILABLE) and answers 200 even when TI is absent. Four interactions: the
// dossier head with an ENABLED TI profile (bands + resolved facts), the honest
// NOT_CONFIGURED head, the evidence page (offset cursor), and the contradiction
// RESOLVE (TI M-3). Merges into ats-web-aramo-core.json.
//
// Vocabulary: bands are words; statements are strings; facts carry a type +
// state + verification status, never a contact value (it stays on the record);
// NO numeric trust signal anywhere. Guard chain: @RequireCapability('ats') +
// @RequireScopes('talent:read') for the reads; ('core') + ('identity:resolve')
// for resolve.

const provider = makeAtsWebProvider();

const DOSSIER_RECORD_ID = '00000000-0000-7000-8000-d05000000001';
const EMPTY_RECORD_ID = '00000000-0000-7000-8000-d05000000010';
const CONTRA_RECORD_ID = '00000000-0000-7000-8000-d05000000022';
const CONTRA_ASSERTION_ID = '00000000-0000-7000-8000-d05000000023';

const NOT_ESTABLISHED = { band: 'NOT_ESTABLISHED' };

describe('ats-web → GET /v1/talent-records/:id/dossier (head)', () => {
  it('returns 200 the dossier head from an ENABLED Talent Intelligence profile', async () => {
    await provider
      .addInteraction()
      .given('a talent record with a Talent Intelligence profile exists')
      .uponReceiving('a trust dossier head read with Talent Intelligence enabled')
      .withRequest('GET', `/v1/talent-records/${DOSSIER_RECORD_ID}/dossier`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          talent_record_id: uuid(DOSSIER_RECORD_ID),
          intelligence_status: 'ENABLED',
          ledger_established: true,
          dimensions: {
            identity: { band: like('CORROBORATED') },
            claims: { band: like('SELF_ASSERTED') },
            continuity: { band: like('NOT_ESTABLISHED') },
            eligibility: { band: like('NOT_ESTABLISHED') },
          },
          statements: like(['All evidence comes from a single source.']),
          facts: eachLike({
            fact_type: like('CURRENT_EMPLOYER'),
            fact_key: like(''),
            value: like({}),
            state: like('RESOLVED'),
            verification_status: like('DECLARED'),
            corroborated: like(false),
          }),
          contradictions: like([]),
          verifications: like([]),
          has_open_dispute: like(false),
          generated_at: regex(ISO_TIMESTAMP, '2026-07-01T00:00:00.000Z'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-records/${DOSSIER_RECORD_ID}/dossier`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { intelligence_status: string; ledger_established: boolean; facts: unknown[] };
        expect(body.intelligence_status).toBe('ENABLED');
        expect(body.ledger_established).toBe(true);
        expect(body.facts.length).toBeGreaterThan(0);
      });
  });

  it('returns 200 the uniform empty head when Talent Intelligence is not configured', async () => {
    await provider
      .addInteraction()
      .given('a talent record exists and Talent Intelligence is not configured')
      .uponReceiving('a trust dossier head read with Talent Intelligence not configured')
      .withRequest('GET', `/v1/talent-records/${EMPTY_RECORD_ID}/dossier`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          talent_record_id: uuid(EMPTY_RECORD_ID),
          intelligence_status: 'NOT_CONFIGURED',
          ledger_established: false,
          dimensions: {
            identity: NOT_ESTABLISHED,
            claims: NOT_ESTABLISHED,
            continuity: NOT_ESTABLISHED,
            eligibility: NOT_ESTABLISHED,
          },
          statements: [],
          facts: [],
          contradictions: [],
          verifications: [],
          has_open_dispute: false,
          generated_at: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-records/${EMPTY_RECORD_ID}/dossier`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { intelligence_status: string; ledger_established: boolean };
        expect(body.intelligence_status).toBe('NOT_CONFIGURED');
        expect(body.ledger_established).toBe(false);
      });
  });
});

describe('ats-web → GET /v1/talent-records/:id/dossier/evidence (timeline)', () => {
  it('returns 200 a page of the tenant-view evidence with each assertion history', async () => {
    await provider
      .addInteraction()
      .given('a talent record with a Talent Intelligence profile exists')
      .uponReceiving('a trust dossier evidence read with Talent Intelligence enabled')
      .withRequest('GET', `/v1/talent-records/${DOSSIER_RECORD_ID}/dossier/evidence`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          intelligence_status: 'ENABLED',
          items: eachLike({
            assertion_id: uuid(),
            assertion_type: like('EMPLOYMENT'),
            contributed_by: like('REQUESTING_TENANT'),
            source_kind: like('ATS_RECORD'),
            verification_status: like('DECLARED'),
            status: like('VALID'),
            assertion_payload: like({}),
            observed_at: regex(ISO_TIMESTAMP, '2026-06-01T00:00:00.000Z'),
            ai_derived: like(false),
            history: eachLike({
              event_type: like('CREATED'),
              at: regex(ISO_TIMESTAMP, '2026-06-01T00:00:00.000Z'),
            }),
          }),
          next_cursor: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-records/${DOSSIER_RECORD_ID}/dossier/evidence`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[]; next_cursor: string | null };
        expect(Array.isArray(body.items)).toBe(true);
        expect(body.next_cursor).toBeNull();
      });
  });
});

describe('ats-web → POST /v1/talent/identity/contradictions/:assertionId/resolve (TI M-3)', () => {
  it('returns 200 RESOLVED for a standing contradiction (KEEP)', async () => {
    const BODY = {
      talent_record_id: CONTRA_RECORD_ID,
      reason: 'reviewed — distinct roles, not a conflict',
      resolution: 'KEEP',
    };
    await provider
      .addInteraction()
      .given('a talent record with a standing contradiction exists')
      .uponReceiving('a contradiction-resolution (KEEP) from the trust tab')
      .withRequest('POST', `/v1/talent/identity/contradictions/${CONTRA_ASSERTION_ID}/resolve`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          status: 'RESOLVED',
          assertion_id: uuid(CONTRA_ASSERTION_ID),
          resolution: 'KEEP',
          assertion_status: like('VALID'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent/identity/contradictions/${CONTRA_ASSERTION_ID}/resolve`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; resolution: string };
        expect(body.status).toBe('RESOLVED');
        expect(body.resolution).toBe('KEEP');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
