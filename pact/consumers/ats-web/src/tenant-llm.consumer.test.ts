import { describe, expect, it } from 'vitest';

import { ACCESS_COOKIE, like, makeAtsWebProvider } from './support/ats-web-pact.js';

// TENANT-LLM-1 §P2/§7 — ats-web → per-tenant Anthropic key admin surface
// (Settings → Integrations → AI/LLM → Anthropic). Guard chain mirrors the
// connector controller: @RequireCapability('ats') + integration:write (set/
// clear) / integration:read (status). The key is WRITE-ONLY — no endpoint
// ever returns it; the only shape that crosses this boundary is the has-key
// status { provider: 'anthropic', configured: boolean }. `provider` is pinned
// (exact literal the FE client TenantLlmKeyStatus depends on); `configured` is
// a like() type-matcher — the consumer depends on the boolean SHAPE, never a
// specific value (the provider env resolves it write-only via Secrets Manager).
// The integration:write given-state is shared with the connector consumer; the
// integration:read state is added for the status read.

const provider = makeAtsWebProvider();

const statusBody = (configuredExample: boolean) => ({
  provider: 'anthropic',
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
        b.jsonBody(statusBody(true));
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
        b.jsonBody(statusBody(false));
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
        b.jsonBody(statusBody(false));
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
