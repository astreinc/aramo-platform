import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  TALENT_ID,
  like,
  makeAtsWebProvider,
  uuid,
} from './support/ats-web-pact.js';

// TR-9 B1 (D5) — Pact consumer for ats-web, reference-attestation capture. A
// recruiter records a reference they already lawfully hold; the platform
// contacts no one. Merges into ats-web-aramo-core.json.
//
// One happy interaction — POST /v1/talent-records/:id/reference-attestations →
// 201 { recorded, evidence_id }. Cookie-authed; guard chain
// @RequireCapability('ats') + @RequireScopes('talent:edit'). The body carries the
// attester descriptor + relationship + statement class + the statement words —
// NO rating field exists (R10: a reference with a number is a review).
// Reuses the live-record provider state.

const provider = makeAtsWebProvider();

describe('ats-web → POST /v1/talent-records/:id/reference-attestations', () => {
  it('returns 201 recording a reference as ATTESTATION evidence', async () => {
    await provider
      .addInteraction()
      .given('an ats-web recruiter and a live talent record for reference capture')
      .uponReceiving('a request to record a reference attestation')
      .withRequest(
        'POST',
        `/v1/talent-records/${TALENT_ID}/reference-attestations`,
        (b) => {
          b.headers({
            Cookie: like(ACCESS_COOKIE),
            'Content-Type': 'application/json',
          }).jsonBody({
            attester: {
              name: 'Charles Babbage',
              email: 'babbage@ext.example',
              company: 'Analytical Engines',
              role: 'Director',
            },
            relationship: 'former manager',
            statement_class: 'WORK',
            statement: 'Led the engine team ably over two years.',
            period: { start: '2019-01', end: '2021-03' },
          });
        },
      )
      .willRespondWith(201, (b) => {
        b.jsonBody({
          recorded: like(true),
          evidence_id: uuid(),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(
          `${mock.url}/v1/talent-records/${TALENT_ID}/reference-attestations`,
          {
            method: 'POST',
            headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              attester: {
                name: 'Charles Babbage',
                email: 'babbage@ext.example',
                company: 'Analytical Engines',
                role: 'Director',
              },
              relationship: 'former manager',
              statement_class: 'WORK',
              statement: 'Led the engine team ably over two years.',
              period: { start: '2019-01', end: '2021-03' },
            }),
          },
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as { evidence_id: string };
        expect(typeof body.evidence_id).toBe('string');
      });
  });
});

beforeAll(() => undefined);
afterAll(() => undefined);
