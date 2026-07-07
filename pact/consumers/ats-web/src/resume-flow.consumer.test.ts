import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  like,
  makeAtsWebProvider,
} from './support/ats-web-pact.js';

// PC-6 — mock-infra: the FE-orchestrated resume flow (PC-4a-resume). Backends
// (ObjectStorageService, ResumeParserService) are provider-mocked; the
// controller HTTP shapes stay live-verified. Merges into ats-web-aramo-core.json.
//
// Scope (PC-6 Directive §1/§3 + Gate-5 ruling): 2 happy interactions —
//   - POST /v1/talent-records/resume-upload-url (presigned PUT; FE consumes
//     presigned_url + storage_key — upload-url internals rule from PC-4);
//   - POST /v1/talent-records/draft-from-resume (parse -> prefill).
//
// illegal-state / idempotency: 0-by-substrate. refusal: 0-by-ruling (the
// filename/content_type/storage_key 422s re-confirmed framework-validation —
// FE constrains — hardening park).
//
// Guard chain: @RequireCapability('ats') + @RequireScopes (attachment:create /
// talent:read) + @RequireSiteMatch().

const provider = makeAtsWebProvider();

describe('ats-web → POST /v1/talent-records/resume-upload-url', () => {
  it('returns 200 with a presigned upload url + storage key', async () => {
    const BODY = { filename: 'resume.pdf', content_type: 'application/pdf' };
    await provider
      .addInteraction()
      .given('an ats-web recruiter can start a resume flow')
      .uponReceiving('a resume upload-url request')
      .withRequest('POST', '/v1/talent-records/resume-upload-url', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ storage_key: like('resumes/pact-seed.pdf'), presigned_url: like('https://mock-storage.local/put/pact-seed') });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-records/resume-upload-url`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { presigned_url: string; storage_key: string };
        expect(body.presigned_url).toBeTruthy();
        expect(body.storage_key).toBeTruthy();
      });
  });
});

describe('ats-web → POST /v1/talent-records/draft-from-resume', () => {
  it('returns 200 with a parsed prefill', async () => {
    const BODY = { storage_key: 'resumes/pact-seed.pdf' };
    await provider
      .addInteraction()
      .given('an ats-web recruiter can start a resume flow')
      .uponReceiving('a draft-from-resume parse request')
      .withRequest('POST', '/v1/talent-records/draft-from-resume', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          prefill: {
            first_name: like('Grace'),
            last_name: like('Hopper'),
            email1: like('grace@example.com'),
          },
          parse_status: 'parsed',
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-records/draft-from-resume`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { parse_status: string };
        expect(body.parse_status).toBe('parsed');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
