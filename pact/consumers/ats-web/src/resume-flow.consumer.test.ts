import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  like,
  makeAtsWebProvider,
} from './support/ats-web-pact.js';

// The résumé upload-url HTTP shape (presigned PUT). The FE consumes
// presigned_url + storage_key; backends (ObjectStorageService) are
// provider-mocked. Merges into ats-web-aramo-core.json.
//
// NOTE: the synchronous POST /v1/talent-records/draft-from-resume interaction was
// REMOVED — that endpoint is retired. Résumé-first creation is now the durable
// async Talent Intake flow (POST /v1/talent-intake-drafts → complete-upload(202)
// → background worker → GET/SSE → promote), documented in openapi/ats.yaml and
// proven end-to-end by libs/talent-record .../durable-async-talent-intake
// integration spec. The intake HTTP interactions are added with matched provider
// state handlers under the contracts follow-up.
//
// Guard chain: @RequireCapability('ats') + @RequireScopes (attachment:create) +
// @RequireSiteMatch().

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

beforeAll(() => undefined);
afterAll(() => undefined);
