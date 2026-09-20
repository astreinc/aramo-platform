import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  ISO_TIMESTAMP,
  like,
  makeAtsWebProvider,
  regex,
  uuid,
} from './support/ats-web-pact.js';

// TALENT-INTEL-1 TI-1G — Pact consumer for ats-web: the governed work-authorization
// current state + append-only assertion history (GET
// /v1/talent-records/:id/work-authorization). `current` is the DETERMINISTIC
// selection (future/expired excluded; newest-asserted wins); history is retained
// (never destroyed). Guard chain: @RequireCapability('ats') + talent:read +
// @RequireSiteMatch().

const provider = makeAtsWebProvider();

const WA_TALENT_ID = '00000000-0000-7000-8000-7a0000000018';

describe('ats-web → GET /v1/talent-records/:id/work-authorization', () => {
  it('returns 200 with the current state + assertion history', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a talent with a work-authorization assertion exist')
      .uponReceiving('a work-authorization state read')
      .withRequest('GET', `/v1/talent-records/${WA_TALENT_ID}/work-authorization`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          talent_id: uuid(WA_TALENT_ID),
          current: {
            work_authorization_status: like('VISA_HOLDER'),
            authorized_to_work_in: [],
            visa_type: null,
            requires_sponsorship: false,
            asserted_at: regex(ISO_TIMESTAMP, '2026-07-01T00:00:00Z'),
            effective_from: null,
            effective_to: null,
            expires_at: null,
          },
          history: [
            {
              work_authorization_status: like('VISA_HOLDER'),
              authorized_to_work_in: [],
              visa_type: null,
              requires_sponsorship: false,
              asserted_at: regex(ISO_TIMESTAMP, '2026-07-01T00:00:00Z'),
              effective_from: null,
              effective_to: null,
              expires_at: null,
            },
          ],
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talent-records/${WA_TALENT_ID}/work-authorization`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { current: { work_authorization_status: string } | null };
        expect(body.current?.work_authorization_status).toBe('VISA_HOLDER');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
