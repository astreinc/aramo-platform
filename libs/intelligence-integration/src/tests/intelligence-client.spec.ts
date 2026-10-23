import { describe, expect, it, vi } from 'vitest';

import { loadIntelligenceConfig } from '../lib/intelligence-config.js';
import {
  IntelligenceClient,
  IntelligenceNotConfiguredError,
  IntelligenceRejectedError,
  IntelligenceUnavailableError,
  type IntelligenceFetch,
} from '../lib/intelligence-client.js';

// ATI-SEP-1 T8 — the HTTP client: token exchange + cache, typed errors, timeouts.

const ENV = {
  INTELLIGENCE_SERVICE_URL: 'http://ti.test:3004/',
  INTELLIGENCE_ATS_CLIENT_ID: 'aramo-ats',
  INTELLIGENCE_ATS_CLIENT_SECRET: 's'.repeat(40),
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function tokenResponse(token = 'tok-1', expires_in = 900): Response {
  return json(200, { access_token: token, token_type: 'Bearer', expires_in, scope: 'intelligence:ingest' });
}

const ERASED = { source_system_id: 'ARAMO_ATS', source_tenant_id: 't', external_talent_id: 'x', source_event_id: 'e', occurred_at: '2026-10-20T00:00:00.000Z' } as const;

describe('ATI-SEP-1 T8 — loadIntelligenceConfig', () => {
  it('everything optional: unset → not configured; verification off; defaults', () => {
    const c = loadIntelligenceConfig({});
    expect(c).toMatchObject({ configured: false, serviceUrl: null, verificationEnabled: false, timeoutMs: 5000, entitlementSyncIntervalMs: 900000, inboundSyncIntervalMs: 5000 });
  });
  it('URL alone (the compose default) is NOT configured — the credentials are required too', () => {
    expect(loadIntelligenceConfig({ INTELLIGENCE_SERVICE_URL: 'http://ti:3004' }).configured).toBe(false);
  });
  it('URL + credentials → configured; trailing slash trimmed; verification only on the literal "true"', () => {
    const c = loadIntelligenceConfig({ ...ENV, INTELLIGENCE_VERIFICATION_ENABLED: 'TRUE' });
    expect(c.configured).toBe(true);
    expect(c.serviceUrl).toBe('http://ti.test:3004');
    expect(c.verificationEnabled).toBe(true);
    expect(loadIntelligenceConfig({ ...ENV, INTELLIGENCE_VERIFICATION_ENABLED: '1' }).verificationEnabled).toBe(false);
  });
  it('a non-http URL is ignored', () => {
    expect(loadIntelligenceConfig({ ...ENV, INTELLIGENCE_SERVICE_URL: 'ti:3004' }).configured).toBe(false);
  });
});

describe('ATI-SEP-1 T8 — IntelligenceClient', () => {
  it('not configured → IntelligenceNotConfiguredError and NO network call', async () => {
    const fetchImpl = vi.fn<IntelligenceFetch>();
    const client = new IntelligenceClient(loadIntelligenceConfig({}), fetchImpl);
    await expect(client.ingestErased(ERASED)).rejects.toBeInstanceOf(IntelligenceNotConfiguredError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('exchanges client_credentials once and reuses the token until near expiry', async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn<IntelligenceFetch>(async (url) =>
      url.endsWith('/v1/oauth/token') ? tokenResponse('tok-1', 900) : json(200, { outcome: 'ERASED', intelligence_subject_id: null, subject_access_state: null, replayed: false }),
    );
    const client = new IntelligenceClient(loadIntelligenceConfig(ENV), fetchImpl, () => now);
    await client.ingestErased(ERASED);
    await client.ingestErased(ERASED);
    const tokenCalls = fetchImpl.mock.calls.filter(([u]) => u.endsWith('/v1/oauth/token'));
    expect(tokenCalls).toHaveLength(1);
    const body = JSON.parse(String(tokenCalls[0]?.[1].body));
    expect(body).toEqual({ grant_type: 'client_credentials', client_id: 'aramo-ats', client_secret: ENV.INTELLIGENCE_ATS_CLIENT_SECRET });
    const call = fetchImpl.mock.calls.find(([u]) => u.endsWith('/v1/ingest/talent/erased'));
    expect((call?.[1].headers as Record<string, string>)['authorization']).toBe('Bearer tok-1');
    expect(call?.[1].signal).toBeInstanceOf(AbortSignal);
    // 900 s TTL, refreshed 60 s early → a new exchange after 840 s.
    now += 841_000;
    await client.ingestErased(ERASED);
    expect(fetchImpl.mock.calls.filter(([u]) => u.endsWith('/v1/oauth/token'))).toHaveLength(2);
  });

  it('a 401 from a TI route drops the token and retries once with a fresh one', async () => {
    let tokens = 0;
    let erasedCalls = 0;
    const fetchImpl = vi.fn<IntelligenceFetch>(async (url) => {
      if (url.endsWith('/v1/oauth/token')) return tokenResponse(`tok-${++tokens}`);
      erasedCalls++;
      return erasedCalls === 1 ? json(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }) : json(200, { outcome: 'ERASED' });
    });
    const client = new IntelligenceClient(loadIntelligenceConfig(ENV), fetchImpl);
    await expect(client.ingestErased(ERASED)).resolves.toMatchObject({ outcome: 'ERASED' });
    expect(tokens).toBe(2);
  });

  it('503 / 429 / network / timeout → IntelligenceUnavailableError (retryable)', async () => {
    for (const make of [
      async () => json(503, {}),
      async () => json(429, {}),
      async () => {
        throw new TypeError('fetch failed');
      },
      async () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      },
    ]) {
      const fetchImpl = vi.fn<IntelligenceFetch>(async (url) => (url.endsWith('/v1/oauth/token') ? tokenResponse() : make()));
      const client = new IntelligenceClient(loadIntelligenceConfig(ENV), fetchImpl);
      const err = await client.ingestErased(ERASED).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IntelligenceUnavailableError);
      expect((err as IntelligenceUnavailableError).retryable).toBe(true);
    }
  });

  it('a 4xx refusal → IntelligenceRejectedError with the TI error code and details', async () => {
    const fetchImpl = vi.fn<IntelligenceFetch>(async (url) =>
      url.endsWith('/v1/oauth/token') ? tokenResponse() : json(422, { error: { code: 'INVALID_CODE', message: 'wrong code', attempts_remaining: 3 } }),
    );
    const client = new IntelligenceClient(loadIntelligenceConfig(ENV), fetchImpl);
    const err = (await client.confirmVerification('11111111-1111-7111-8111-111111111111', '123456').catch((e: unknown) => e)) as IntelligenceRejectedError;
    expect(err).toBeInstanceOf(IntelligenceRejectedError);
    expect(err).toMatchObject({ status: 422, code: 'INVALID_CODE', details: { attempts_remaining: 3 }, retryable: false });
  });

  it('a refused token exchange (invalid_client) is a typed refusal, not a retry', async () => {
    const fetchImpl = vi.fn<IntelligenceFetch>(async () => json(401, { error: 'invalid_client', error_description: 'bad secret' }));
    const client = new IntelligenceClient(loadIntelligenceConfig(ENV), fetchImpl);
    await expect(client.ingestErased(ERASED)).rejects.toMatchObject({ name: 'IntelligenceRejectedError', status: 401, code: 'invalid_client' });
  });

  it('readProfile addresses the tenant reference tuple (ARAMO_ATS / tenant / talent)', async () => {
    const fetchImpl = vi.fn<IntelligenceFetch>(async (url) => (url.endsWith('/v1/oauth/token') ? tokenResponse() : json(200, { facts: [] })));
    const client = new IntelligenceClient(loadIntelligenceConfig(ENV), fetchImpl);
    await client.readProfile({ tenant_id: 'ten', talent_id: 'tal' });
    expect(fetchImpl.mock.calls.some(([u, i]) => u === 'http://ti.test:3004/v1/references/ARAMO_ATS/ten/tal/profile' && i.method === 'GET')).toBe(true);
  });
});
