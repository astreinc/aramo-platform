import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  like,
  makeAtsWebProvider,
  uuid,
} from './support/ats-web-pact.js';

// PC-6 — mock-infra: the LLM-backed requisition drafting surface (PC-5-aidraft).
// The DraftProvider seam is provider-mocked with a deterministic canonical
// draft (no live LLM in CI, ever); the AiDraftService + controller shapes stay
// live-verified. Merges into ats-web-aramo-core.json.
//
// Scope (PC-6 Directive §1/§3 + Gate-5 ruling): 2 happy interactions —
//   - POST /v1/requisitions/intake (intake_text -> extracted fields + jd_text
//     + skills + audit id);
//   - POST /v1/requisitions/:id/profile/draft (brief -> golden_profile_draft +
//     draft_event_id).
//
// illegal-state / idempotency: 0-by-substrate. refusal: 0-by-ruling (empty-
// text 400 / not-visible 404 / AI_RATE_LIMITED / AI_PROVIDER_UNAVAILABLE →
// hardening park; the deterministic mock always succeeds).
//
// Guard chain: @RequireCapability('ats') + @RequireScopes (requisition:create /
// requisition:profile:generate) + @RequireSiteMatch(). profile/draft reads the
// requisition (findByIdForActor; requisition:read:all short-circuits).

const provider = makeAtsWebProvider();

const REQ_ID = '00000000-0000-7000-8000-4e9000000001';

describe('ats-web → POST /v1/requisitions/intake', () => {
  it('returns 200 with extracted intake fields + skills', async () => {
    const BODY = { intake_text: 'We need a senior TypeScript engineer for the platform team.' };
    await provider
      .addInteraction()
      .given('an ats-web recruiter can draft a requisition from intake')
      .uponReceiving('a requisition intake draft')
      .withRequest('POST', '/v1/requisitions/intake', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          fields: like({}),
          jd_text: like('Senior Engineer — pact draft.'),
          required_skills: like([{ name: like('TypeScript') }]),
          nice_to_have_skills: like([{ name: like('GraphQL') }]),
          ai_draft_audit_record_id: like('00000000-0000-7000-8000-000000000abc'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/requisitions/intake`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { jd_text: string; required_skills: unknown[] };
        expect(body.jd_text).toBeTruthy();
        expect(body.required_skills.length).toBeGreaterThan(0);
      });
  });
});

describe('ats-web → POST /v1/requisitions/:id/profile/draft', () => {
  it('returns 200 with a golden-profile draft + draft_event_id', async () => {
    const BODY = { brief: 'Senior TypeScript engineer, platform team, remote.' };
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a requisition for drafting exist')
      .uponReceiving('a requisition profile draft')
      .withRequest('POST', `/v1/requisitions/${REQ_ID}/profile/draft`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          draft_event_id: uuid(),
          jd_text: like('Senior Engineer — pact draft.'),
          golden_profile_draft: like({ jd_text: like('Senior Engineer — pact draft.') }),
          ai_draft_audit_record_id: like('00000000-0000-7000-8000-000000000abc'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/requisitions/${REQ_ID}/profile/draft`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { draft_event_id: string };
        expect(body.draft_event_id).toBeTruthy();
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
