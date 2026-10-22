import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  ISO_TIMESTAMP,
  TALENT_ID,
  eachLike,
  like,
  makeAtsWebProvider,
  regex,
  uuid,
} from './support/ats-web-pact.js';

// ATS-QA-1 I-4 (L2) — Pact consumer for ats-web, recruiter education edit. One
// happy interaction — POST /v1/talent-records/:id/education → 201 { entry_id,
// education[] }: the added entry is source `manual` with no resume provenance.
// Cookie-authed; guard chain @RequireCapability('ats') + @RequireScopes
// ('talent:edit'). Correct (PUT) and remove (DELETE) return the same shape and
// are proven over HTTP in apps/api (ats-qa-1-talent-education.integration.spec.ts).
// Merges into ats-web-aramo-core.json.

const provider = makeAtsWebProvider();

const BODY = {
  institution_name: 'State University',
  degree_name: 'BS',
  field_of_study: 'Computer Science',
  conferred_date: '2012-05-15',
};

describe('ats-web → POST /v1/talent-records/:id/education', () => {
  it('returns 201 with the added manual entry in the current education', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a live talent record for education edit')
      .uponReceiving('a request to add an education entry')
      .withRequest('POST', `/v1/talent-records/${TALENT_ID}/education`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({
          entry_id: uuid(),
          education: eachLike({
            id: uuid(),
            institution_name: like('State University'),
            degree_name: like('BS'),
            field_of_study: like('Computer Science'),
            conferred_date: like('2012-05-15'),
            source: 'manual',
            source_document_id: null,
            source_refs: [],
            corrects_entry_id: null,
            recorded_at: regex(ISO_TIMESTAMP, '2026-10-22T00:00:00.000Z'),
          }),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-records/${TALENT_ID}/education`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { entry_id: string; education: Array<{ source: string }> };
        expect(typeof body.entry_id).toBe('string');
        expect(body.education[0]?.source).toBe('manual');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
