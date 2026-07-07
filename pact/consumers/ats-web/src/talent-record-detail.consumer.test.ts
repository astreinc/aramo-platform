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

// PC-4b — Pact consumer for ats-web, talent-record DETAIL (post-B3). The
// supersession-aware detail read PC-4 deferred as DEFER-TR2-MOTION; now pinned
// at its settled DDR-3 shape. Merges into ats-web-aramo-core.json.
//
// Scope (PC-4b Directive §1/§3 + Gate-5 ruling): GET /v1/talent-records/:id via
// projectDetailView — 2 happy interactions capturing the full DDR-3 shape:
//   - live record: record_status='live', superseded_by_record_id=null,
//     superseded_at=null;
//   - superseded record: record_status='superseded', superseded_by_record_id +
//     superseded_at non-null (the surviving record speaks for this human).
//
// The three supersession fields are DETAIL-only (projectDetailView); list/
// search (PC-4) omit them entirely, so PC-4's list/create/update pins stay
// byte-identical.
//
// illegal-state / idempotency: 0-by-substrate (GET). refusal: 0-by-ruling
// (NOT_FOUND generic → park; §8 enrichment inversion ratified — detail fires
// NONE of the talent-enrichment interceptors; read-closure = talent_record).
//
// Guard chain: @RequireCapability('ats') + @RequireScopes('talent:read') +
// @RequireSiteMatch().

const provider = makeAtsWebProvider();

const DETAIL_LIVE_ID = '00000000-0000-7000-8000-7a0000000010';
const DETAIL_SUPERSEDED_ID = '00000000-0000-7000-8000-7a0000000011';
const SUPERSEDED_BY_ID = '00000000-0000-7000-8000-7a0000000012';

function detailView(
  id: string,
  opts: { superseded?: boolean } = {},
) {
  return {
    id: uuid(id),
    tenant_id: uuid(TENANT_ID),
    site_id: null,
    first_name: like('Ada'),
    last_name: like('Lovelace'),
    can_relocate: like(false),
    is_hot: like(false),
    record_status: opts.superseded ? 'superseded' : 'live',
    superseded_by_record_id: opts.superseded ? uuid(SUPERSEDED_BY_ID) : null,
    superseded_at: opts.superseded
      ? regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z')
      : null,
    created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
    updated_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
  };
}

describe('ats-web → GET /v1/talent-records/:id (detail)', () => {
  it('returns 200 with a live record (supersession fields null)', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a live talent record exist')
      .uponReceiving('a talent-record detail read (live)')
      .withRequest('GET', `/v1/talent-records/${DETAIL_LIVE_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(detailView(DETAIL_LIVE_ID));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-records/${DETAIL_LIVE_ID}`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          record_status: string;
          superseded_by_record_id: string | null;
        };
        expect(body.record_status).toBe('live');
        expect(body.superseded_by_record_id).toBeNull();
      });
  });

  it('returns 200 with a superseded record (supersession fields set)', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a superseded talent record exist')
      .uponReceiving('a talent-record detail read (superseded)')
      .withRequest('GET', `/v1/talent-records/${DETAIL_SUPERSEDED_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(detailView(DETAIL_SUPERSEDED_ID, { superseded: true }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/talent-records/${DETAIL_SUPERSEDED_ID}`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          record_status: string;
          superseded_by_record_id: string | null;
        };
        expect(body.record_status).toBe('superseded');
        expect(body.superseded_by_record_id).not.toBeNull();
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
