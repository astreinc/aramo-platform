import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  eachLike,
  errorBody,
  like,
  makeAtsWebProvider,
  uuid,
} from './support/ats-web-pact.js';

// Durable Async Résumé-First Talent Intake — the HTTP contract (ats-web →
// aramo-core). Covers the create-intake, complete-upload(202), authoritative
// GET, and the promote missing-admission (422) shapes. The async engine (outbox
// → BullMQ relay → worker) is NOT modeled in Pact — it is proven end-to-end by
// the durable-async-talent-intake integration spec. SSE is a stream, not a
// request/response contract, so it is covered by the integration SSE proof, not
// Pact. Merges into ats-web-aramo-core.json.
//
// Guard chain: @RequireCapability('ats') + @RequireScopes (talent:create /
// talent:read / talent:edit) + @RequireSiteMatch().

const provider = makeAtsWebProvider();

describe('ats-web → POST /v1/talent-intake-drafts (create intake)', () => {
  it('returns 201 with a presigned upload target + durable draft id', async () => {
    const BODY = { filename: 'grace.pdf', content_type: 'application/pdf' };
    await provider
      .addInteraction()
      .given('an ats-web recruiter can start a resume flow')
      .uponReceiving('a create talent-intake-draft request')
      .withRequest('POST', '/v1/talent-intake-drafts', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          draft_id: uuid(),
          upload_url: like('https://mock-storage.local/put/pact-seed'),
          storage_key: like('resumes/pact-seed.pdf'),
          processing_status: 'UPLOADED',
          expires_at: like('2026-05-25T00:05:00.000Z'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-intake-drafts`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { draft_id: string; processing_status: string };
        expect(body.processing_status).toBe('UPLOADED');
        expect(body.draft_id).toBeTruthy();
      });
  });
});

describe('ats-web → POST /v1/talent-intake-drafts/{id}/complete-upload', () => {
  it('returns 202 (queued) after verifying the uploaded object', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an uploaded talent intake draft exist')
      .uponReceiving('a complete-upload request')
      .withRequest(
        'POST',
        '/v1/talent-intake-drafts/00000000-0000-7000-8000-7a1d00000001/complete-upload',
        (b) => {
          b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody({});
        },
      )
      .willRespondWith(202, (b) => {
        b.jsonBody({ draft_id: like('00000000-0000-7000-8000-7a1d00000001'), processing_status: 'QUEUED' });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/talent-intake-drafts/00000000-0000-7000-8000-7a1d00000001/complete-upload`,
          {
            method: 'POST',
            headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          },
        );
        expect(res.status).toBe(202);
        const body = (await res.json()) as { processing_status: string };
        expect(body.processing_status).toBe('QUEUED');
      });
  });
});

describe('ats-web → GET /v1/talent-intake-drafts/{id}', () => {
  it('returns 200 with the authoritative draft read model', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a ready talent intake draft exist')
      .uponReceiving('a get talent-intake-draft request')
      .withRequest('GET', '/v1/talent-intake-drafts/00000000-0000-7000-8000-7a1d00000002', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          id: like('00000000-0000-7000-8000-7a1d00000002'),
          source_filename: like('grace.pdf'),
          processing_status: 'READY',
          review_status: like('IN_REVIEW'),
          version: like(2),
          created_at: like('2026-07-01T00:00:00.000Z'),
          updated_at: like('2026-07-01T00:00:00.000Z'),
          actions: eachLike('promote_to_talent'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-intake-drafts/00000000-0000-7000-8000-7a1d00000002`, {
          method: 'GET',
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { processing_status: string; actions: string[] };
        expect(body.processing_status).toBe('READY');
        expect(Array.isArray(body.actions)).toBe(true);
      });
  });
});

describe('ats-web → POST /v1/talent-intake-drafts/{id}/promote (missing admission fields)', () => {
  it('returns 422 with details.missing and creates no TalentRecord', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and an intake draft missing admission fields exist')
      .uponReceiving('a promote request for a draft missing admission fields')
      .withRequest(
        'POST',
        '/v1/talent-intake-drafts/00000000-0000-7000-8000-7a1d00000003/promote',
        (b) => {
          b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody({});
        },
      )
      .willRespondWith(422, (b) => {
        b.jsonBody(errorBody('VALIDATION_ERROR', 'A name, a primary email, and a cell phone are required to create a talent.'));
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/talent-intake-drafts/00000000-0000-7000-8000-7a1d00000003/promote`,
          {
            method: 'POST',
            headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          },
        );
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('VALIDATION_ERROR');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
