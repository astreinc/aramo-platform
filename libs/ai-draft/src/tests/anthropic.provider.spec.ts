import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';

// TENANT-LLM-1 — the provider now builds a client per call from the tenant's own
// key (no shared/cached client → no cross-tenant leak). So the client is mocked at
// the SDK-module level (not via a field). Mock error classes so `instanceof` in
// translateAnthropicError resolves against the SAME classes the provider imports.
let createImpl: (args: Record<string, unknown>) => Promise<unknown> = async () => ({});
let lastKey: string | undefined;

class MockErr extends Error {}
class MockAPIError extends MockErr {}
class MockRateLimitError extends MockErr {}
class MockAuthenticationError extends MockErr {}
class MockBadRequestError extends MockErr {}
class MockUnprocessableEntityError extends MockErr {}
class MockInternalServerError extends MockErr {}
class MockAPIConnectionError extends MockErr {}
class MockAPIConnectionTimeoutError extends MockErr {}

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    constructor(opts: { apiKey: string }) {
      lastKey = opts.apiKey;
    }
    messages = { create: (args: Record<string, unknown>) => createImpl(args) };
  }
  return {
    default: MockAnthropic,
    APIError: MockAPIError,
    RateLimitError: MockRateLimitError,
    AuthenticationError: MockAuthenticationError,
    BadRequestError: MockBadRequestError,
    UnprocessableEntityError: MockUnprocessableEntityError,
    InternalServerError: MockInternalServerError,
    APIConnectionError: MockAPIConnectionError,
    APIConnectionTimeoutError: MockAPIConnectionTimeoutError,
  };
});

const { AnthropicProvider } = await import('../lib/providers/anthropic.provider.js');
const { SecretCacheService } = await import('../lib/secrets/secret-cache.service.js');
const { LlmKeyNotConfiguredError } = await import(
  '../lib/secrets/llm-key-not-configured.error.js'
);

const TENANT = '11111111-1111-7111-8111-111111111111';

function makeSecretCache(key = 'sk-ant-test') {
  const sc = new SecretCacheService();
  vi.spyOn(sc, 'getProviderApiKey').mockResolvedValue(key);
  return sc;
}
function gen(provider: InstanceType<typeof AnthropicProvider>) {
  return provider.generate({ tenant_id: TENANT, model: 'm', prompt: 'p', max_tokens: 1 });
}

describe('AnthropicProvider (TENANT-LLM-1)', () => {
  it('resolves the key with the OWNED tenant_id and binds the client to it', async () => {
    const sc = makeSecretCache('sk-ant-tenant-A');
    const spy = vi.spyOn(sc, 'getProviderApiKey').mockResolvedValue('sk-ant-tenant-A');
    const provider = new AnthropicProvider(sc);
    createImpl = async () => ({
      id: 'msg_01',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const result = await gen(provider);
    expect(spy).toHaveBeenCalledWith(TENANT, 'anthropic'); // resolved by owned tenant_id
    expect(lastKey).toBe('sk-ant-tenant-A'); // client bound to that tenant's key
    expect(result.completion).toBe('hi');
  });

  it('a not-configured tenant key propagates (fail-closed, no fallback)', async () => {
    const sc = new SecretCacheService();
    vi.spyOn(sc, 'getProviderApiKey').mockRejectedValue(new LlmKeyNotConfiguredError(TENANT));
    const provider = new AnthropicProvider(sc);
    await expect(gen(provider)).rejects.toBeInstanceOf(LlmKeyNotConfiguredError);
  });

  it('maps successful response to ProviderGenerateResult', async () => {
    const provider = new AnthropicProvider(makeSecretCache());
    createImpl = async () => ({
      id: 'msg_01',
      model: 'claude-sonnet-4-6',
      content: [
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const result = await gen(provider);
    expect(result.completion).toBe('hello world');
    expect(result.model_used).toBe('claude-sonnet-4-6');
    expect(result.input_tokens).toBe(10);
    expect(result.output_tokens).toBe(5);
    expect(result.provider_request_id).toBe('msg_01');
  });

  const cases: Array<[string, Error, string, string?, number?]> = [
    ['APIConnectionError', new MockAPIConnectionError(), 'provider_unavailable', 'INTERNAL_ERROR', 502],
    ['APIConnectionTimeoutError', new MockAPIConnectionTimeoutError(), 'provider_unavailable'],
    ['RateLimitError', new MockRateLimitError(), 'provider_rate_limited', 'INTERNAL_ERROR', 429],
    ['AuthenticationError', new MockAuthenticationError(), 'provider_auth_failed'],
    ['BadRequestError', new MockBadRequestError(), 'provider_input_invalid', 'VALIDATION_ERROR'],
    ['UnprocessableEntityError', new MockUnprocessableEntityError(), 'provider_input_invalid', 'VALIDATION_ERROR'],
    ['InternalServerError', new MockInternalServerError(), 'provider_internal_error', 'INTERNAL_ERROR', 502],
  ];
  for (const [name, err, kind, code, status] of cases) {
    it(`translates ${name} → ${kind}`, async () => {
      const provider = new AnthropicProvider(makeSecretCache());
      createImpl = () => Promise.reject(err);
      try {
        await gen(provider);
        expect.fail('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(AramoError);
        expect((e as AramoError).context.details?.['kind']).toBe(kind);
        if (code !== undefined) expect((e as AramoError).code).toBe(code);
        if (status !== undefined) expect((e as AramoError).statusCode).toBe(status);
      }
    });
  }
});
