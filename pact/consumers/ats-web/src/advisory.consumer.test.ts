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

// PC-4b — Pact consumer for ats-web, advisory-resolution domain (post-B3). The
// split-biased same-human resolution surface PC-4 deferred; now settled. Path
// base is /v1/talent/identity/advisories (Gate-5 path correction). Merges into
// ats-web-aramo-core.json.
//
// Scope (PC-4b Directive §3.5 + Gate-5 ruling): 7 interactions —
//   happy (3): approve -> MERGED, dismiss -> DISMISSED, reverse -> REVERSED;
//   illegal-state (2): approve an already-resolved advisory -> 409;
//     reverse a not-MERGED advisory -> 409;
//   refusal (2): approve a has_contradiction advisory without override -> 400;
//     reverse without a justification -> 400.
//
// idempotency: 0-by-substrate (no Idempotency-Key).
//
// TR-6 B2 (DDR D5 + PC Exit Accounting §5.1 — the coordinated fix): the advisory
// refusals now throw AramoError with ADVISORY-SCOPE DOMAIN CODES instead of Nest
// built-in exceptions the AramoExceptionFilter status-collapsed to the
// semantically-false generic codes (409→IDEMPOTENCY_KEY_CONFLICT,
// 400→VALIDATION_ERROR). The 4 refusal/illegal-state interactions below pin the
// TRUE codes: ADVISORY_NOT_PENDING (409), ADVISORY_NOT_MERGED (409),
// CONTRADICTION_OVERRIDE_REQUIRED (400), REVERSAL_JUSTIFICATION_REQUIRED (400).
// This PR updates them + the provider in the same slice — coordinated by design.
// The 3 happy interactions are unchanged. The filter itself is untouched.
//
// Guard chain: @RequireCapability('core') + @RequireScopes('identity:resolve').

const provider = makeAtsWebProvider();

const ADV_BASE = '/v1/talent/identity/advisories';
const ADV_PENDING_ID = '00000000-0000-7000-8000-adf000000001';
const ADV_MERGED_ID = '00000000-0000-7000-8000-adf000000002';
const ADV_CONTRADICTION_ID = '00000000-0000-7000-8000-adf000000003';
const ADV_SUBJECT_A = '00000000-0000-7000-8000-5b1000000006';
const ADV_SUBJECT_B = '00000000-0000-7000-8000-5b1000000007';

function advisoryView(id: string, status: string) {
  return {
    id: uuid(id),
    tenant_id: uuid(TENANT_ID),
    subject_a_id: uuid(ADV_SUBJECT_A),
    subject_b_id: uuid(ADV_SUBJECT_B),
    advise_band: like('ADVISE_STRONG'),
    has_contradiction: like(false),
    match_basis: like({}),
    status,
    created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
  };
}

// ======================================================================
// TR-6 B2 (DDR D5) — the reviewer worklist read: keyset-paginated + enriched
// (bands + named KINDS only, never values; R10 clean (bands, not numeric signals)). New FE interaction,
// pinned with the correct shape from day one.
// ======================================================================
describe('ats-web → GET /v1/talent/identity/advisories (worklist)', () => {
  it('returns 200 an enriched keyset page of PENDING_REVIEW advisories', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a pending advisory without contradiction exist')
      .uponReceiving('an identity advisories worklist read')
      .withRequest('GET', ADV_BASE, (b) => {
        b.query({ status: 'PENDING_REVIEW' }).headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: [
            {
              id: uuid(ADV_PENDING_ID),
              tenant_id: uuid(TENANT_ID),
              subject_a_id: uuid(ADV_SUBJECT_A),
              subject_b_id: uuid(ADV_SUBJECT_B),
              advise_band: like('ADVISE_STRONG'),
              has_contradiction: like(false),
              status: 'PENDING_REVIEW',
              created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
              // Named KINDS only — never a normalized value; bands only, no numeric ordering signal (R10).
              confirmed_kinds: like([]),
              contradiction_kinds: like([]),
              corroborator_conflict_kinds: like([]),
              shared_anchor_kinds: like([]),
              reopened_at: null,
              reopened_from_band: null,
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
        const body = (await res.json()) as {
          items: Array<{ status: string; shared_anchor_kinds: string[] }>;
          next_cursor: string | null;
        };
        expect(body.items.length).toBeGreaterThan(0);
        expect(body.items[0]!.status).toBe('PENDING_REVIEW');
        expect(Array.isArray(body.items[0]!.shared_anchor_kinds)).toBe(true);
        expect(body.next_cursor).toBeNull();
      });
  });
});

// ======================================================================
// happy — approve / dismiss / reverse
// ======================================================================
describe('ats-web → advisory resolution (happy)', () => {
  it('returns 200 MERGED on approve', async () => {
    const BODY = { surviving_subject_id: ADV_SUBJECT_A };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a pending advisory without contradiction exist')
      .uponReceiving('an advisory approve')
      .withRequest('POST', `${ADV_BASE}/${ADV_PENDING_ID}/approve`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(advisoryView(ADV_PENDING_ID, 'MERGED'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${ADV_BASE}/${ADV_PENDING_ID}/approve`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string };
        expect(body.status).toBe('MERGED');
      });
  });

  it('returns 200 DISMISSED on dismiss', async () => {
    const BODY = { justification: 'Different people on review.' };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a pending advisory without contradiction exist')
      .uponReceiving('an advisory dismiss')
      .withRequest('POST', `${ADV_BASE}/${ADV_PENDING_ID}/dismiss`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(advisoryView(ADV_PENDING_ID, 'DISMISSED'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${ADV_BASE}/${ADV_PENDING_ID}/dismiss`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string };
        expect(body.status).toBe('DISMISSED');
      });
  });

  it('returns 200 REVERSED on reverse', async () => {
    const BODY = { justification: 'The merge was wrong; distinct humans.' };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a merged advisory exist')
      .uponReceiving('an advisory reverse')
      .withRequest('POST', `${ADV_BASE}/${ADV_MERGED_ID}/reverse`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(advisoryView(ADV_MERGED_ID, 'REVERSED'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${ADV_BASE}/${ADV_MERGED_ID}/reverse`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string };
        expect(body.status).toBe('REVERSED');
      });
  });
});

// ======================================================================
// illegal-state — 409 (state-machine guards)
// ======================================================================
describe('ats-web → advisory resolution (illegal-state)', () => {
  it('returns 409 approving an already-resolved advisory', async () => {
    const BODY = { surviving_subject_id: ADV_SUBJECT_A };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a merged advisory exist')
      .uponReceiving('an advisory approve on an already-resolved advisory')
      .withRequest('POST', `${ADV_BASE}/${ADV_MERGED_ID}/approve`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(
          errorBody('ADVISORY_NOT_PENDING', 'advisory is already MERGED — cannot re-resolve'),
        );
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${ADV_BASE}/${ADV_MERGED_ID}/approve`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('ADVISORY_NOT_PENDING');
      });
  });

  it('returns 409 reversing a not-MERGED advisory', async () => {
    const BODY = { justification: 'attempted reverse' };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a pending advisory without contradiction exist')
      .uponReceiving('an advisory reverse on a not-MERGED advisory')
      .withRequest('POST', `${ADV_BASE}/${ADV_PENDING_ID}/reverse`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(
          errorBody('ADVISORY_NOT_MERGED', 'advisory is PENDING_REVIEW, not MERGED — cannot reverse'),
        );
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${ADV_BASE}/${ADV_PENDING_ID}/reverse`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('ADVISORY_NOT_MERGED');
      });
  });
});

// ======================================================================
// refusal — 400 (split-biased business invariants)
// ======================================================================
describe('ats-web → advisory resolution (refusal)', () => {
  it('returns 400 approving a contradiction advisory without override', async () => {
    const BODY = { surviving_subject_id: ADV_SUBJECT_A };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a pending advisory with a contradiction exist')
      .uponReceiving('an advisory approve without the contradiction override')
      .withRequest('POST', `${ADV_BASE}/${ADV_CONTRADICTION_ID}/approve`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(400, (b) => {
        b.jsonBody(
          errorBody(
            'CONTRADICTION_OVERRIDE_REQUIRED',
            'contradiction_override_required: merging an advisory with has_contradiction=true requires override_acknowledged=true and a justification',
          ),
        );
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${ADV_BASE}/${ADV_CONTRADICTION_ID}/approve`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('CONTRADICTION_OVERRIDE_REQUIRED');
      });
  });

  it('returns 400 reversing without a justification', async () => {
    const BODY = {};
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a merged advisory exist')
      .uponReceiving('an advisory reverse without a justification')
      .withRequest('POST', `${ADV_BASE}/${ADV_MERGED_ID}/reverse`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(400, (b) => {
        b.jsonBody(errorBody('REVERSAL_JUSTIFICATION_REQUIRED', 'reversal_justification_required'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${ADV_BASE}/${ADV_MERGED_ID}/reverse`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('REVERSAL_JUSTIFICATION_REQUIRED');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
