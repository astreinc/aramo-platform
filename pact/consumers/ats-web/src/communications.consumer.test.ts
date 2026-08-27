import { describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  ISO_TIMESTAMP,
  eachLike,
  like,
  makeAtsWebProvider,
  regex,
  uuid,
} from './support/ats-web-pact.js';

// COMM-B2 (Aramo-COMM-V1) — Pact consumer for the ats-web Communications/Voice
// READ skeleton. Pins the read-contract SHAPE for the three B2 routes:
//   - GET /v1/communications/capabilities (provider-neutral descriptor),
//   - GET /v1/communications/me/provider-identity (secret-free mapping),
//   - GET /v1/communications/interactions/{id} (the canonical calling record).
// COMM-B7 adds the post-call surface (the FE consumer lands later, but the
// contract is pinned NOW to prevent drift):
//   - GET /v1/talents/{talentId}/communications (the timeline),
//   - POST /v1/communications/interactions/{id}/disposition.
// Call initiation (B5) is provider→us only and not consumer-driven here.

const provider = makeAtsWebProvider();

const INTERACTION_ID = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
const CONNECTION_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

describe('ats-web → GET /v1/communications/capabilities', () => {
  it('returns 200 with a provider-neutral capability descriptor', async () => {
    await provider
      .addInteraction()
      .given('a tenant entitled to ats with a configured zoom_phone provider connection')
      .uponReceiving('an ats-web communications capabilities read')
      .withRequest('GET', '/v1/communications/capabilities', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          provider_key: like('zoom_phone'),
          capabilities: {
            voice: {
              outbound: like(true),
              inbound: like(true),
              embedded: like(true),
            },
          },
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/communications/capabilities`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { provider_key: string };
        expect(typeof body.provider_key).toBe('string');
      });
  });
});

describe('ats-web → GET /v1/communications/me/provider-identity', () => {
  it('returns 200 with the caller mapping (secret-free)', async () => {
    await provider
      .addInteraction()
      .given('a tenant entitled to ats with a caller holding communication:read and a mapped provider identity')
      .uponReceiving('an ats-web communications provider-identity read')
      .withRequest('GET', '/v1/communications/me/provider-identity', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          recruiter_id: uuid('00000000-0000-7000-8000-000000000001'),
          provider_user_id: like('pv-user-1'),
          provider_extension_id: null,
          display_phone_number: null,
          extension: null,
          voice_enabled: like(true),
          sms_enabled: like(false),
          status: like('active'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/communications/me/provider-identity`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const raw = await res.text();
        expect(raw).not.toMatch(/secret|token|credential/i);
      });
  });
});

describe('ats-web → GET /v1/communications/interactions/{id}', () => {
  it('returns 200 with a communication interaction view', async () => {
    await provider
      .addInteraction()
      .given('a tenant entitled to ats with a caller holding communication:read and one communication interaction')
      .uponReceiving('an ats-web communication interaction read')
      .withRequest('GET', `/v1/communications/interactions/${INTERACTION_ID}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          id: uuid(INTERACTION_ID),
          channel: like('voice'),
          direction: like('outbound'),
          status: like('created'),
          integration_connection_id: uuid(CONNECTION_ID),
          from_address: like('+15715550100'),
          to_address: like('+17035550111'),
          started_at: null,
          ringing_at: null,
          connected_at: null,
          ended_at: null,
          duration_seconds: null,
          created_at: regex(ISO_TIMESTAMP, '2026-08-25T00:00:01Z'),
          updated_at: regex(ISO_TIMESTAMP, '2026-08-25T00:00:01Z'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/communications/interactions/${INTERACTION_ID}`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { id: string; channel: string };
        expect(body.id).toBe(INTERACTION_ID);
        expect(body.channel).toBe('voice');
      });
  });
});

describe('ats-web → GET /v1/communications/provider-identities (admin)', () => {
  it('returns 200 with the tenant provider-identity mappings', async () => {
    await provider
      .addInteraction()
      .given('a tenant entitled to ats with a configured zoom_phone connection and a provider-identity mapping')
      .uponReceiving('an ats-web provider-identity admin list read')
      .withRequest('GET', '/v1/communications/provider-identities', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: eachLike({
            recruiter_id: uuid('00000000-0000-7000-8000-000000000001'),
            provider_user_id: like('pv-user-1'),
            provider_extension_id: null,
            display_phone_number: null,
            extension: null,
            voice_enabled: like(true),
            sms_enabled: like(false),
            status: like('active'),
          }),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/communications/provider-identities`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const raw = await res.text();
        expect(raw).not.toMatch(/secret|token|credential/i);
      });
  });
});

describe('ats-web → PUT /v1/communications/provider-identities/{recruiterId} (admin)', () => {
  it('returns 200 with the upserted mapping', async () => {
    const recruiterId = '00000000-0000-7000-8000-000000000002';
    await provider
      .addInteraction()
      .given('a tenant entitled to ats with a configured zoom_phone connection')
      .uponReceiving('an ats-web provider-identity admin upsert')
      .withRequest('PUT', `/v1/communications/provider-identities/${recruiterId}`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody({
          provider_user_id: 'pv-user-2',
          voice_enabled: true,
        });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          recruiter_id: uuid(recruiterId),
          provider_user_id: like('pv-user-2'),
          provider_extension_id: null,
          display_phone_number: null,
          extension: null,
          voice_enabled: like(true),
          sms_enabled: like(false),
          status: like('active'),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/communications/provider-identities/${recruiterId}`, {
          method: 'PUT',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider_user_id: 'pv-user-2', voice_enabled: true }),
        });
        expect(res.status).toBe(200);
      });
  });
});

describe('ats-web → GET /v1/talents/{talentId}/communications (COMM-B7 timeline)', () => {
  it('returns 200 with a keyset page of interactions + disposition history', async () => {
    await provider
      .addInteraction()
      .given('a tenant entitled to ats with a caller holding communication:read and a talent with one dispositioned communication interaction')
      .uponReceiving('an ats-web talent communication timeline read')
      .withRequest('GET', `/v1/talents/${TALENT_ID}/communications`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          items: eachLike({
            id: uuid(INTERACTION_ID),
            channel: like('voice'),
            direction: like('outbound'),
            status: like('completed'),
            integration_connection_id: uuid(CONNECTION_ID),
            from_address: like('+15715550100'),
            to_address: like('+17035550111'),
            started_at: null,
            ringing_at: null,
            connected_at: null,
            ended_at: null,
            duration_seconds: null,
            created_at: regex(ISO_TIMESTAMP, '2026-08-25T00:00:01Z'),
            updated_at: regex(ISO_TIMESTAMP, '2026-08-25T00:00:01Z'),
            dispositions: eachLike({
              id: uuid('dddddddd-dddd-7ddd-8ddd-dddddddddddd'),
              disposition: like('connected'),
              notes: null,
              dispositioned_at: regex(ISO_TIMESTAMP, '2026-08-25T00:00:02Z'),
            }),
          }),
          next_cursor: null,
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/talents/${TALENT_ID}/communications`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: Array<{ dispositions: unknown[] }>; next_cursor: string | null };
        expect(Array.isArray(body.items)).toBe(true);
        expect(Array.isArray(body.items[0]?.dispositions)).toBe(true);
      });
  });
});

describe('ats-web → POST /v1/communications/interactions/{id}/provider-reference (COMM-B8)', () => {
  it('returns 200 with the interaction id when a provider correlation id is attached', async () => {
    await provider
      .addInteraction()
      .given('a tenant entitled to ats with a caller holding communication:voice:call and an interaction they initiated')
      .uponReceiving('an ats-web provider-reference capture')
      .withRequest('POST', `/v1/communications/interactions/${INTERACTION_ID}/provider-reference`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody({
          provider_call_element_id: 'elem-capture-1',
        });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({ id: uuid(INTERACTION_ID) });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/communications/interactions/${INTERACTION_ID}/provider-reference`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider_call_element_id: 'elem-capture-1' }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { id: string };
        expect(body.id).toBe(INTERACTION_ID);
      });
  });
});

describe('ats-web → POST /v1/communications/interactions/{id}/disposition (COMM-B7)', () => {
  it('returns 201 with the recorded disposition id', async () => {
    await provider
      .addInteraction()
      .given('a tenant entitled to ats with a caller holding communication:disposition:write and one communication interaction')
      .uponReceiving('an ats-web disposition record')
      .withRequest('POST', `/v1/communications/interactions/${INTERACTION_ID}/disposition`, (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody({
          disposition: 'no_answer',
        });
      })
      .willRespondWith(201, (b) => {
        b.jsonBody({ id: uuid('dddddddd-dddd-7ddd-8ddd-dddddddddddd') });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/communications/interactions/${INTERACTION_ID}/disposition`, {
          method: 'POST',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify({ disposition: 'no_answer' }),
        });
        expect(res.status).toBe(201);
      });
  });
});
