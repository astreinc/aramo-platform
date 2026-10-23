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

// PC-4b → ATI-SEP-1 T10 WP2 (Addenda A2 F-1 / A3) — Pact consumer for ats-web,
// the within-tenant duplicate-advisory resolution surface, rebuilt on the ATS
// talent_duplicate_advisory table (detected from ATS data, resolved by a human;
// no Talent Intelligence output gates it). Path base /v1/talent/identity/advisories.
// Merges into ats-web-aramo-core.json.
//
// Scope: 7 interactions —
//   read (1): the PENDING_REVIEW worklist (record pair named by record ids);
//   happy (3): approve → APPROVED (surviving_record_id), dismiss → DISMISSED,
//     reverse → REVERSED;
//   illegal-state (2): approve an already-resolved advisory → 409
//     ADVISORY_NOT_PENDING; reverse a not-approved advisory → 409 ADVISORY_NOT_MERGED;
//   refusal (1): reverse without a justification → 400 REVERSAL_JUSTIFICATION_REQUIRED.
// The retired contradiction-override refusal is gone (the ATS advisory carries no
// contradiction state; override_acknowledged is accepted and ignored).
//
// Guard chain: @RequireCapability('core') + @RequireScopes('identity:resolve').

const provider = makeAtsWebProvider();

const ADV_BASE = '/v1/talent/identity/advisories';
const ADV_PENDING_ID = '00000000-0000-7000-8000-adf000000001';
const ADV_APPROVED_ID = '00000000-0000-7000-8000-adf000000002';
const RECORD_A_ID = '00000000-0000-7000-8000-7a00000000a1';
const RECORD_B_ID = '00000000-0000-7000-8000-7a00000000a2';

function advisoryView(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id: uuid(id),
    tenant_id: uuid(TENANT_ID),
    talent_record_a_id: uuid(RECORD_A_ID),
    talent_record_b_id: uuid(RECORD_B_ID),
    sourced_talent_id: null,
    basis: like('EMAIL'),
    shared_anchor_kinds: like(['EMAIL']),
    status,
    created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00.000Z'),
    ...extra,
  };
}

async function post(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('ats-web → GET /v1/talent/identity/advisories (worklist)', () => {
  it('returns 200 a keyset page of PENDING_REVIEW duplicate advisories', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a pending duplicate advisory exist')
      .uponReceiving('a duplicate advisories worklist read')
      .withRequest('GET', ADV_BASE, (b) => {
        b.query({ status: 'PENDING_REVIEW' }).headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: [
            {
              id: uuid(ADV_PENDING_ID),
              tenant_id: uuid(TENANT_ID),
              talent_record_a_id: uuid(RECORD_A_ID),
              talent_record_a_name: like('Ada Lovelace'),
              talent_record_b_id: uuid(RECORD_B_ID),
              talent_record_b_name: like('Ada Lovelace'),
              sourced_talent_id: null,
              sourced_talent_name: null,
              basis: like('EMAIL'),
              status: 'PENDING_REVIEW',
              created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00.000Z'),
              // Named KINDS only — never a normalized value (R10).
              shared_anchor_kinds: like(['EMAIL']),
            },
          ],
          next_cursor: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${ADV_BASE}?status=PENDING_REVIEW`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: Array<{ status: string }>; next_cursor: string | null };
        expect(body.items[0]!.status).toBe('PENDING_REVIEW');
        expect(body.next_cursor).toBeNull();
      });
  });
});

describe('ats-web → duplicate advisory resolution (happy)', () => {
  it('returns 200 APPROVED with the surviving record on approve', async () => {
    const BODY = { surviving_record_id: RECORD_A_ID, justification: 'Same person on review.' };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a pending duplicate advisory exist')
      .uponReceiving('a duplicate advisory approve')
      .withRequest('POST', `${ADV_BASE}/${ADV_PENDING_ID}/approve`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(
          advisoryView(ADV_PENDING_ID, 'APPROVED', {
            surviving_record_id: uuid(RECORD_A_ID),
            superseded_record_id: uuid(RECORD_B_ID),
            merge_completed_at: regex(ISO_TIMESTAMP, '2026-05-26T00:00:00.000Z'),
          }),
        );
      })
      .executeTest(async (mock) => {
        const res = await post(mock.url, `${ADV_BASE}/${ADV_PENDING_ID}/approve`, BODY);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; surviving_record_id: string };
        expect(body.status).toBe('APPROVED');
        expect(body.surviving_record_id).toBe(RECORD_A_ID);
      });
  });

  it('returns 200 DISMISSED on dismiss', async () => {
    const BODY = { justification: 'Different people on review.' };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a pending duplicate advisory exist')
      .uponReceiving('a duplicate advisory dismiss')
      .withRequest('POST', `${ADV_BASE}/${ADV_PENDING_ID}/dismiss`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(advisoryView(ADV_PENDING_ID, 'DISMISSED'));
      })
      .executeTest(async (mock) => {
        const res = await post(mock.url, `${ADV_BASE}/${ADV_PENDING_ID}/dismiss`, BODY);
        expect(res.status).toBe(200);
        expect(((await res.json()) as { status: string }).status).toBe('DISMISSED');
      });
  });

  it('returns 200 REVERSED on reverse', async () => {
    const BODY = { justification: 'The approval was wrong; distinct humans.' };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an approved duplicate advisory exist')
      .uponReceiving('a duplicate advisory reverse')
      .withRequest('POST', `${ADV_BASE}/${ADV_APPROVED_ID}/reverse`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(
          advisoryView(ADV_APPROVED_ID, 'REVERSED', {
            reversal_justification: like(BODY.justification),
            post_merge_accretions: like([]),
          }),
        );
      })
      .executeTest(async (mock) => {
        const res = await post(mock.url, `${ADV_BASE}/${ADV_APPROVED_ID}/reverse`, BODY);
        expect(res.status).toBe(200);
        expect(((await res.json()) as { status: string }).status).toBe('REVERSED');
      });
  });
});

describe('ats-web → duplicate advisory resolution (illegal-state)', () => {
  it('returns 409 ADVISORY_NOT_PENDING approving an already-resolved advisory', async () => {
    const BODY = { surviving_record_id: RECORD_A_ID };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an approved duplicate advisory exist')
      .uponReceiving('a duplicate advisory approve on an already-resolved advisory')
      .withRequest('POST', `${ADV_BASE}/${ADV_APPROVED_ID}/approve`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(errorBody('ADVISORY_NOT_PENDING', 'This advisory has already been resolved'));
      })
      .executeTest(async (mock) => {
        const res = await post(mock.url, `${ADV_BASE}/${ADV_APPROVED_ID}/approve`, BODY);
        expect(res.status).toBe(409);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ADVISORY_NOT_PENDING');
      });
  });

  it('returns 409 ADVISORY_NOT_MERGED reversing a not-approved advisory', async () => {
    const BODY = { justification: 'attempted reverse' };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a pending duplicate advisory exist')
      .uponReceiving('a duplicate advisory reverse on a not-approved advisory')
      .withRequest('POST', `${ADV_BASE}/${ADV_PENDING_ID}/reverse`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(errorBody('ADVISORY_NOT_MERGED', 'Only an approved advisory can be reversed'));
      })
      .executeTest(async (mock) => {
        const res = await post(mock.url, `${ADV_BASE}/${ADV_PENDING_ID}/reverse`, BODY);
        expect(res.status).toBe(409);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ADVISORY_NOT_MERGED');
      });
  });
});

describe('ats-web → duplicate advisory resolution (refusal)', () => {
  it('returns 400 REVERSAL_JUSTIFICATION_REQUIRED reversing without a justification', async () => {
    const BODY = {};
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an approved duplicate advisory exist')
      .uponReceiving('a duplicate advisory reverse without a justification')
      .withRequest('POST', `${ADV_BASE}/${ADV_APPROVED_ID}/reverse`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(400, (b) => {
        b.jsonBody(errorBody('REVERSAL_JUSTIFICATION_REQUIRED', 'A justification is required to reverse an approval'));
      })
      .executeTest(async (mock) => {
        const res = await post(mock.url, `${ADV_BASE}/${ADV_APPROVED_ID}/reverse`, BODY);
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('REVERSAL_JUSTIFICATION_REQUIRED');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
