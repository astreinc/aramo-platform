import { describe, expect, it } from 'vitest';

import { ACCESS_COOKIE, eachLike, like, makeAtsWebProvider, uuid } from './support/ats-web-pact.js';

// COMM-C3 — Pact consumer for the ats-web engagement readiness read (the drawer
// Submittal-readiness surface). Pins the provider-neutral contract SHAPE. The
// dormant (never-governed) case is the simplest deterministic pin: policy_present
// false + governed false + satisfied true (submittal proceeds under the standard
// gates). The governed block/allow paths are proven in the api integration suite.

const provider = makeAtsWebProvider();

const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const REQ_ID = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

describe('ats-web → GET /v1/engagement/readiness (COMM-C3)', () => {
  it('returns 200 with provider-neutral readiness (dormant: governed=false)', async () => {
    await provider
      .addInteraction()
      .given('a tenant entitled to ats with no engagement policy published')
      .uponReceiving('an ats-web engagement readiness read')
      .withRequest('GET', '/v1/engagement/readiness', (b) => {
        b.query({ talent_id: TALENT_ID, requisition_id: REQ_ID }).headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          governed: like(false),
          policy_present: like(false),
          satisfied: like(true),
          unavailable: like(false),
          missing: [],
          results: [],
          capabilities: eachLike({ channel: like('voice'), available: like(true) }),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/engagement/readiness?talent_id=${TALENT_ID}&requisition_id=${REQ_ID}`,
          { headers: { Cookie: ACCESS_COOKIE } },
        );
        expect(res.status).toBe(200);
        const raw = await res.text();
        expect(raw).not.toMatch(/zoom|microsoft|secret|token/i); // provider-neutral
        const body = (await JSON.parse(raw)) as { governed: boolean };
        expect(typeof body.governed).toBe('boolean');
      });
  });
});
