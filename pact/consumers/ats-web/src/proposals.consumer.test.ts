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

// TR-12 B2 (§3.4) — Pact consumer for ats-web, the caseworker's Trust Proposals
// worklist. Interactions: the keyset list (default OPEN, enriched with the record
// pointer), the dismiss (→ DISMISSED), the mark-acted (→ ACTED), and the two
// OPEN-only guards (dismiss/act on a terminal proposal → 409 PROPOSAL_NOT_OPEN).
// Merges into ats-web-aramo-core.json.
//
// Vocabulary (R10): kind + trigger + basis_kinds are WORDS; created_at a timestamp;
// NO value, NO number anywhere. record_id is the enriched pointer (the slot for a
// one-click email VERIFY/RENEW is proven end-to-end in the api integration test,
// where the anchor value is also proven absent). Guard chain: @RequireCapability
// ('ats') + @RequireScopes('talent:read') — the queue disposes/annotates its own
// rows; the real ACTs carry their own scope.

const provider = makeAtsWebProvider();

const BASE = '/v1/talent/identity/proposals';
const PROP_OPEN_ID = '00000000-0000-7000-8000-d12000000001';
const PROP_TERMINAL_ID = '00000000-0000-7000-8000-d12000000002';
const PROP_SUBJECT_ID = '00000000-0000-7000-8000-d12000000005';
const PROP_RECORD_ID = '00000000-0000-7000-8000-d12000000010';
const PROP_EVIDENCE_ID = '00000000-0000-7000-8000-d12000000020';

function proposalItem(id: string, status: string) {
  return {
    id: uuid(id),
    tenant_id: uuid(TENANT_ID),
    subject_id: uuid(PROP_SUBJECT_ID),
    kind: 'RESOLVE_CONTRADICTION',
    trigger_kind: like('OPEN_CONTRADICTION'),
    basis_ref_id: uuid(PROP_EVIDENCE_ID),
    // Named KINDS only — never a value, never a number (R10).
    basis_kinds: like(['EMPLOYMENT']),
    status,
    created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
    record_id: uuid(PROP_RECORD_ID),
  };
}

describe('ats-web → GET /v1/talent/identity/proposals (worklist)', () => {
  it('returns 200 a keyset page of OPEN proposals, enriched with the record pointer', async () => {
    await provider
      .addInteraction()
      .given('an open trust proposal exists')
      .uponReceiving('a trust proposals worklist read')
      .withRequest('GET', BASE, (b) => {
        b.query({ status: 'OPEN' }).headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: [proposalItem(PROP_OPEN_ID, 'OPEN')],
          next_cursor: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${BASE}?status=OPEN`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          items: Array<{ status: string; kind: string; basis_kinds: string[] }>;
          next_cursor: string | null;
        };
        expect(body.items.length).toBeGreaterThan(0);
        expect(body.items[0]!.status).toBe('OPEN');
        expect(Array.isArray(body.items[0]!.basis_kinds)).toBe(true);
        expect(body.next_cursor).toBeNull();
      });
  });
});

describe('ats-web → trust proposal bookkeeping (happy)', () => {
  it('returns 200 DISMISSED on dismiss', async () => {
    const BODY = { justification: 'Handled offline; not worth queueing.' };
    await provider
      .addInteraction()
      .given('an open trust proposal exists')
      .uponReceiving('a trust proposal dismiss')
      .withRequest('POST', `${BASE}/${PROP_OPEN_ID}/dismiss`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(proposalItem(PROP_OPEN_ID, 'DISMISSED'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${BASE}/${PROP_OPEN_ID}/dismiss`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string };
        expect(body.status).toBe('DISMISSED');
      });
  });

  it('returns 200 ACTED on mark-acted', async () => {
    const BODY = { note: 'Sent the verification from the record.' };
    await provider
      .addInteraction()
      .given('an open trust proposal exists')
      .uponReceiving('a trust proposal mark-acted')
      .withRequest('POST', `${BASE}/${PROP_OPEN_ID}/act`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(proposalItem(PROP_OPEN_ID, 'ACTED'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${BASE}/${PROP_OPEN_ID}/act`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string };
        expect(body.status).toBe('ACTED');
      });
  });
});

describe('ats-web → trust proposal bookkeeping (OPEN-only guard)', () => {
  it('returns 409 PROPOSAL_NOT_OPEN dismissing a terminal proposal', async () => {
    const BODY = { justification: 'attempted re-dismiss' };
    await provider
      .addInteraction()
      .given('a terminal trust proposal exists')
      .uponReceiving('a trust proposal dismiss on a terminal proposal')
      .withRequest('POST', `${BASE}/${PROP_TERMINAL_ID}/dismiss`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(errorBody('PROPOSAL_NOT_OPEN', 'proposal is already DISMISSED — cannot dismiss'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${BASE}/${PROP_TERMINAL_ID}/dismiss`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('PROPOSAL_NOT_OPEN');
      });
  });

  it('returns 409 PROPOSAL_NOT_OPEN marking a terminal proposal acted', async () => {
    const BODY = { note: 'attempted re-act' };
    await provider
      .addInteraction()
      .given('a terminal trust proposal exists')
      .uponReceiving('a trust proposal mark-acted on a terminal proposal')
      .withRequest('POST', `${BASE}/${PROP_TERMINAL_ID}/act`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(409, (b) => {
        b.jsonBody(errorBody('PROPOSAL_NOT_OPEN', 'proposal is already DISMISSED — cannot mark acted'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}${BASE}/${PROP_TERMINAL_ID}/act`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('PROPOSAL_NOT_OPEN');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
