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

// PC-5c — Pact consumer for ats-web, activity domain (Gate-2a desk, part 3).
// The activity feed / note-logging surface. Merges into ats-web-aramo-core.json.
//
// Scope (PC-5 Directive §3 + Gate-5 ruling): 2 happy interactions —
//   - GET /v1/activities (list, {items});
//   - POST /v1/activities (create a note, 201).
//
// illegal-state: 0-by-substrate (activity is append-only, no transition).
// idempotency: 0-by-substrate (no Idempotency-Key).
// refusal: 0-by-ruling (framework validation/scope → hardening park).
// EXCLUDE-R2 (no ats-web call site): GET /v1/activities/:id.
//
// Provider guard chain: @RequireCapability('ats') + @RequireScopes
// (activity:read/create) + @RequireSiteMatch(). The visibility resolvers
// (resolveVisibility + …Requisition + …Pipeline) short-circuit to zero reads
// under company:read:all / requisition:read:all.

const provider = makeAtsWebProvider();

const ACTIVITY_ID = '00000000-0000-7000-8000-ac7100000001';
const SUBJECT_REQ_ID = '00000000-0000-7000-8000-4e9000000001';

function activityView(id: string | undefined, opts: { notes?: string } = {}) {
  return {
    id: id === undefined ? uuid() : uuid(id),
    tenant_id: uuid(TENANT_ID),
    site_id: null,
    type: like('note'),
    subject_type: like('requisition'),
    subject_id: uuid(SUBJECT_REQ_ID),
    notes: like(opts.notes ?? 'Kickoff call notes.'),
    // created_by_id omitted from the assertion: it is null on the SQL-seeded
    // GET row but the actor's id on POST create (set server-side). Pact
    // tolerates the provider including it in either form.
    created_at: regex(ISO_TIMESTAMP, '2026-05-25T00:00:00Z'),
  };
}

// ======================================================================
// GET /v1/activities — happy (list)
// ======================================================================
describe('ats-web → GET /v1/activities', () => {
  it('returns 200 with the activity list', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an activity exist')
      .uponReceiving('an activities list read')
      .withRequest('GET', '/v1/activities', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ items: [activityView(ACTIVITY_ID)] });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/activities`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items.length).toBeGreaterThan(0);
      });
  });
});

// ======================================================================
// POST /v1/activities — happy (create note; 201)
// ======================================================================
describe('ats-web → POST /v1/activities', () => {
  it('returns 201 with the created note', async () => {
    const CREATE_BODY = {
      type: 'note',
      subject_type: 'requisition',
      subject_id: SUBJECT_REQ_ID,
      notes: 'Left a voicemail.',
    };
    await provider
      .addInteraction()
      .given('an ats-web recruiter can create activities')
      .uponReceiving('an activity note create')
      .withRequest('POST', '/v1/activities', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(
          CREATE_BODY,
        );
      })
      .willRespondWith(201, (b) => {
        b.jsonBody(activityView(undefined, { notes: 'Left a voicemail.' }));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/activities`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(CREATE_BODY),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { notes: string };
        expect(body.notes).toBe('Left a voicemail.');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
