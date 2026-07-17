import { resolve } from 'node:path';

import { PactV4, MatchersV3 } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';

const { like } = MatchersV3;

// Portal P4 P4a (§PR-1.1, D-5) — Pact consumer test for the portal-thin client on
// the PUBLIC platform-notice read. Provider: aramo-core (apps/api). The endpoint is
// public BY CONSTRUCTION (a guardless sibling controller) — NO Authorization header
// is sent. Closed { version, text } envelope (the same bytes the email delivers).

const provider = new PactV4({
  consumer: 'portal-thin',
  provider: 'aramo-core',
  dir: resolve(__dirname, '../../../pacts'),
  logLevel: 'warn',
});

describe('portal-thin consumer → GET /v1/portal/notice', () => {
  it('returns the current platform notice (public; no session required)', async () => {
    await provider
      .addInteraction()
      .given('the platform notice registry is available')
      .uponReceiving('a public platform-notice request')
      .withRequest('GET', '/v1/portal/notice')
      .willRespondWith(200, (b) => {
        b.jsonBody({
          version: like('portal-notice-v1'),
          text: like('Aramo maintains a record of your professional identity.'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/portal/notice`, { method: 'GET' });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { version: string; text: string };
        expect(typeof body.version).toBe('string');
        expect(body.text.length).toBeGreaterThan(0);
      });
  });
});
