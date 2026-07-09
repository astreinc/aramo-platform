import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  ISO_TIMESTAMP,
  like,
  makeAtsWebProvider,
  uuid,
} from './support/ats-web-pact.js';

// TR-14 B2 (§3.3) — Pact consumer for ats-web, the trust dossier domain. Four
// interactions: the dossier head (a record with a ledger), the honest empty state
// (a record with no subject), a keyset evidence-timeline page, and — the pact
// deferred by name since TR-4 — the contradiction RESOLVE interaction. Merges into
// ats-web-aramo-core.json.
//
// Vocabulary: bands are PresentationBand; statements are strings; NO trust-ordinal
// numeric anywhere (contradictions are items, not counts). The resolve DTO is the
// TR-4 endpoint's exactly (identity:resolve). Guard chain: @RequireCapability('ats')
// + @RequireScopes('talent:read') for the reads; ('core') + ('identity:resolve')
// for resolve.

const provider = makeAtsWebProvider();

const DOSSIER_RECORD_ID = '00000000-0000-7000-8000-d05000000001';
const EMPTY_RECORD_ID = '00000000-0000-7000-8000-d05000000010';
const CONTRA_EVIDENCE_ID = '00000000-0000-7000-8000-d05000000023';

describe('ats-web → GET /v1/talent-records/:id/dossier (head)', () => {
  it('returns 200 the dossier head with per-dimension bands, statements, and item collections', async () => {
    await provider
      .addInteraction()
      .given('a talent record with a trust dossier exists')
      .uponReceiving('a trust dossier head read')
      .withRequest('GET', `/v1/talent-records/${DOSSIER_RECORD_ID}/dossier`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          talent_record_id: uuid(DOSSIER_RECORD_ID),
          ledger_established: like(true),
          dimensions: {
            identity: { band: like('CORROBORATED') },
            claims: { band: like('SELF_ASSERTED') },
            continuity: { band: like('NOT_ESTABLISHED') },
            eligibility: { band: like('NOT_ESTABLISHED') },
          },
          statements: like([]),
          contradictions: like([]),
          verifications: like([]),
          merge_provenance: like([]),
          advisory_pointers: like([]),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-records/${DOSSIER_RECORD_ID}/dossier`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ledger_established: boolean };
        expect(body.ledger_established).toBe(true);
      });
  });

  it('returns 200 the uniform empty shape for a record with no evidence ledger', async () => {
    await provider
      .addInteraction()
      .given('a talent record with no evidence ledger exists')
      .uponReceiving('a trust dossier head read for a record with no subject')
      .withRequest('GET', `/v1/talent-records/${EMPTY_RECORD_ID}/dossier`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          talent_record_id: uuid(EMPTY_RECORD_ID),
          ledger_established: like(false),
          dimensions: {
            identity: { band: like('NOT_ESTABLISHED') },
            claims: { band: like('NOT_ESTABLISHED') },
            continuity: { band: like('NOT_ESTABLISHED') },
            eligibility: { band: like('NOT_ESTABLISHED') },
          },
          statements: like([]),
          contradictions: like([]),
          verifications: like([]),
          merge_provenance: like([]),
          advisory_pointers: like([]),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-records/${EMPTY_RECORD_ID}/dossier`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ledger_established: boolean };
        expect(body.ledger_established).toBe(false);
      });
  });
});

describe('ats-web → GET /v1/talent-records/:id/dossier/evidence (timeline)', () => {
  it('returns 200 a keyset page of the evidence timeline with links inline', async () => {
    await provider
      .addInteraction()
      .given('a talent record with a trust dossier exists')
      .uponReceiving('a trust dossier evidence-timeline read')
      .withRequest('GET', `/v1/talent-records/${DOSSIER_RECORD_ID}/dossier/evidence`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: like([
            {
              event: like({
                id: uuid(),
                event_type: like('CREATED'),
                occurred_at: like('2026-01-01T00:00:00.000Z', ISO_TIMESTAMP),
              }),
              evidence: like({
                id: uuid(),
                dimension: like('CLAIMS'),
                assertion_type: like('EMPLOYMENT'),
                current_status: like('VALID'),
              }),
              links: like([]),
            },
          ]),
          next_cursor: like(null),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/talent-records/${DOSSIER_RECORD_ID}/dossier/evidence`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(Array.isArray(body.items)).toBe(true);
      });
  });
});

describe('ats-web → POST /v1/talent/identity/contradictions/:evidenceId/resolve (TR-4)', () => {
  it('returns 200 RESOLVED for a standing contradiction (the deferred resolve pact)', async () => {
    const BODY = { reason: 'reviewed — distinct roles, not a conflict' };
    await provider
      .addInteraction()
      .given('a talent record with a standing contradiction exists')
      .uponReceiving('a contradiction-resolution from the trust tab')
      .withRequest('POST', `/v1/talent/identity/contradictions/${CONTRA_EVIDENCE_ID}/resolve`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ status: 'RESOLVED', evidence_id: uuid(CONTRA_EVIDENCE_ID) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/talent/identity/contradictions/${CONTRA_EVIDENCE_ID}/resolve`,
          {
            method: 'POST',
            headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
            body: JSON.stringify(BODY),
          },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string };
        expect(body.status).toBe('RESOLVED');
      });
  });
});
