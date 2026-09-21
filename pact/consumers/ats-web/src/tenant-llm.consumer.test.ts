import { describe, expect, it } from 'vitest';

import { ACCESS_COOKIE, eachLike, like, makeAtsWebProvider } from './support/ats-web-pact.js';

// TENANT-LLM-1/2 §P2/§7 — ats-web → per-tenant, MULTI-PROVIDER BYO LLM admin
// surface (Settings → Integrations → AI/LLM). Guard chain mirrors the connector
// controller: @RequireCapability('ats') + integration:write (select-provider,
// set/clear) / integration:read (overview/status). Keys are WRITE-ONLY — no
// endpoint returns one; the shapes that cross are the has-key status
// { provider, configured } and the overview { active_provider, providers }.
// `provider`/`active_provider` are pinned to the wired literal; `configured` is a
// like() type-matcher (the consumer depends on the boolean SHAPE, not a value —
// the provider env resolves it write-only via Secrets Manager). The
// integration:read/write given-states are shared with the connector consumer;
// the active-provider write reuses the tenant-exists state (settings upsert).

const provider = makeAtsWebProvider();

const statusBody = (providerName: string, configuredExample: boolean) => ({
  provider: providerName,
  configured: like(configuredExample),
});

describe('ats-web → tenant LLM key (Anthropic BYO)', () => {
  it('PUT /v1/integrations/llm/anthropic/key sets/rotates the key and returns has-key status', async () => {
    const BODY = { api_key: 'sk-ant-pact-fixture-value' };
    await provider
      .addInteraction()
      .given('a tenant entitled to ats with a caller holding integration:write')
      .uponReceiving('a tenant Anthropic key set/rotate')
      .withRequest('PUT', '/v1/integrations/llm/anthropic/key', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(statusBody('anthropic', true));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/integrations/llm/anthropic/key`, {
          method: 'PUT',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { provider: string; configured: unknown };
        expect(body.provider).toBe('anthropic');
        expect(typeof body.configured).toBe('boolean');
      });
  });

  it('DELETE /v1/integrations/llm/anthropic/key clears the key and returns has-key status', async () => {
    await provider
      .addInteraction()
      .given('a tenant entitled to ats with a caller holding integration:write')
      .uponReceiving('a tenant Anthropic key clear')
      .withRequest('DELETE', '/v1/integrations/llm/anthropic/key', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(statusBody('anthropic', false));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/integrations/llm/anthropic/key`, {
          method: 'DELETE',
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { provider: string; configured: unknown };
        expect(body.provider).toBe('anthropic');
        expect(typeof body.configured).toBe('boolean');
      });
  });

  it('GET /v1/integrations/llm/anthropic/status returns the write-only has-key status', async () => {
    await provider
      .addInteraction()
      .given('a tenant entitled to ats with a caller holding integration:read')
      .uponReceiving('a tenant Anthropic key status read')
      .withRequest('GET', '/v1/integrations/llm/anthropic/status', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(statusBody('anthropic', false));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/integrations/llm/anthropic/status`, {
          headers: { Cookie: ACCESS_COOKIE },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { provider: string; configured: unknown };
        expect(body.provider).toBe('anthropic');
        expect(typeof body.configured).toBe('boolean');
      });
  });
});

describe('ats-web → tenant LLM multi-provider (TENANT-LLM-2)', () => {
  it('GET /v1/integrations/llm returns the active provider + per-provider status', async () => {
    await provider
      .addInteraction()
      .given('a tenant entitled to ats with a caller holding integration:read')
      .uponReceiving('a tenant LLM overview read')
      .withRequest('GET', '/v1/integrations/llm/overview', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE) });
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          active_provider: like('anthropic'),
          providers: eachLike({ provider: like('anthropic'), configured: like(false) }),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/integrations/llm/overview`, { headers: { Cookie: ACCESS_COOKIE } });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { active_provider: string; providers: unknown[] };
        expect(typeof body.active_provider).toBe('string');
        expect(Array.isArray(body.providers)).toBe(true);
      });
  });

  it('PUT /v1/integrations/llm/active-provider selects the active provider', async () => {
    const BODY = { provider: 'openai' };
    await provider
      .addInteraction()
      .given('an ats-web admin and a tenant exist')
      .uponReceiving('a tenant LLM active-provider selection')
      .withRequest('PUT', '/v1/integrations/llm/active-provider', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody({
          active_provider: like('openai'),
          providers: eachLike({ provider: like('anthropic'), configured: like(false) }),
        });
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/integrations/llm/active-provider`, {
          method: 'PUT',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { active_provider: string };
        expect(typeof body.active_provider).toBe('string');
      });
  });

  it('PUT /v1/integrations/llm/openai/key sets the OpenAI key (write-only status)', async () => {
    const BODY = { api_key: 'sk-openai-pact-fixture-value' };
    await provider
      .addInteraction()
      .given('a tenant entitled to ats with a caller holding integration:write')
      .uponReceiving('a tenant OpenAI key set/rotate')
      .withRequest('PUT', '/v1/integrations/llm/openai/key', (b) => {
        b.headers({ Cookie: like(ACCESS_COOKIE), 'Content-Type': 'application/json' }).jsonBody(BODY);
      })
      .willRespondWith(200, (b) => {
        b.jsonBody(statusBody('openai', false));
      })
      .executeTest(async (mock) => {
        const res = await fetch(`${mock.url}/v1/integrations/llm/openai/key`, {
          method: 'PUT',
          headers: { Cookie: ACCESS_COOKIE, 'Content-Type': 'application/json' },
          body: JSON.stringify(BODY),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { provider: string; configured: unknown };
        expect(body.provider).toBe('openai');
        expect(typeof body.configured).toBe('boolean');
      });
  });
});
