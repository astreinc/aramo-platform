import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';

// TENANT-LLM-2 — OpenAI DraftProvider adapter. Builds a client per call from the
// tenant's OWN openai key (no shared client → no cross-tenant leak), resolved by
// the OWNED tenant_id + 'openai'. Error translation has PARITY with the Anthropic
// adapter. The SDK is mocked at the module level; mock error classes so
// `instanceof` resolves against the SAME classes the adapter imports.
let createImpl: (args: Record<string, unknown>) => Promise<unknown> = async () => ({});
let lastKey: string | undefined;

class MockErr extends Error {}
class MockAPIError extends MockErr {}
class MockRateLimitError extends MockErr {}
class MockAuthenticationError extends MockErr {}
class MockPermissionDeniedError extends MockErr {}
class MockBadRequestError extends MockErr {}
class MockUnprocessableEntityError extends MockErr {}
class MockInternalServerError extends MockErr {}
class MockAPIConnectionError extends MockErr {}
class MockAPIConnectionTimeoutError extends MockErr {}

vi.mock('openai', () => {
  class MockOpenAI {
    constructor(opts: { apiKey: string }) {
      lastKey = opts.apiKey;
    }
    chat = { completions: { create: (args: Record<string, unknown>) => createImpl(args) } };
  }
  return {
    default: MockOpenAI,
    APIError: MockAPIError,
    RateLimitError: MockRateLimitError,
    AuthenticationError: MockAuthenticationError,
    PermissionDeniedError: MockPermissionDeniedError,
    BadRequestError: MockBadRequestError,
    UnprocessableEntityError: MockUnprocessableEntityError,
    InternalServerError: MockInternalServerError,
    APIConnectionError: MockAPIConnectionError,
    APIConnectionTimeoutError: MockAPIConnectionTimeoutError,
  };
});

const { OpenAiProvider } = await import('../lib/providers/openai.provider.js');
const { SecretCacheService } = await import('../lib/secrets/secret-cache.service.js');
const { LlmKeyNotConfiguredError } = await import('../lib/secrets/llm-key-not-configured.error.js');

const TENANT = '11111111-1111-7111-8111-111111111111';

function makeSecretCache(key = 'sk-openai-test') {
  const sc = new SecretCacheService();
  vi.spyOn(sc, 'getProviderApiKey').mockResolvedValue(key);
  return sc;
}
function gen(provider: InstanceType<typeof OpenAiProvider>) {
  return provider.generate({ tenant_id: TENANT, model: 'gpt-4o', prompt: 'p', max_tokens: 1 });
}
const okResponse = {
  id: 'chatcmpl_1',
  model: 'gpt-4o',
  choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2 },
};

describe('OpenAiProvider (TENANT-LLM-2)', () => {
  it('resolves the key with the OWNED tenant_id + openai and binds the client to it', async () => {
    const sc = makeSecretCache('sk-openai-tenant-A');
    const spy = vi.spyOn(sc, 'getProviderApiKey').mockResolvedValue('sk-openai-tenant-A');
    createImpl = async () => okResponse;
    const result = await gen(new OpenAiProvider(sc));
    expect(spy).toHaveBeenCalledWith(TENANT, 'openai'); // owned tenant + provider
    expect(lastKey).toBe('sk-openai-tenant-A');
    expect(result.completion).toBe('hi');
    expect(result.model_used).toBe('gpt-4o');
    expect(result.input_tokens).toBe(3);
    expect(result.output_tokens).toBe(2);
    expect(result.provider_request_id).toBe('chatcmpl_1');
  });

  it('a not-configured tenant key propagates (fail-closed, no fallback)', async () => {
    const sc = new SecretCacheService();
    vi.spyOn(sc, 'getProviderApiKey').mockRejectedValue(new LlmKeyNotConfiguredError(TENANT));
    await expect(gen(new OpenAiProvider(sc))).rejects.toBeInstanceOf(LlmKeyNotConfiguredError);
  });

  it('maps RateLimitError → INTERNAL_ERROR 429 (parity)', async () => {
    createImpl = async () => {
      throw new MockRateLimitError('rate');
    };
    try {
      await gen(new OpenAiProvider(makeSecretCache()));
      expect.fail('expected AramoError');
    } catch (e) {
      expect(e).toBeInstanceOf(AramoError);
      expect((e as AramoError).statusCode).toBe(429);
      expect((e as AramoError).context.details?.['kind']).toBe('provider_rate_limited');
    }
  });

  it('maps BadRequestError → VALIDATION_ERROR 400 (parity)', async () => {
    createImpl = async () => {
      throw new MockBadRequestError('bad');
    };
    try {
      await gen(new OpenAiProvider(makeSecretCache()));
      expect.fail('expected AramoError');
    } catch (e) {
      expect((e as AramoError).statusCode).toBe(400);
      expect((e as AramoError).context.details?.['kind']).toBe('provider_input_invalid');
    }
  });

  it('maps connection failures → INTERNAL_ERROR 502 provider_unavailable (parity)', async () => {
    createImpl = async () => {
      throw new MockAPIConnectionError('down');
    };
    try {
      await gen(new OpenAiProvider(makeSecretCache()));
      expect.fail('expected AramoError');
    } catch (e) {
      expect((e as AramoError).statusCode).toBe(502);
      expect((e as AramoError).context.details?.['kind']).toBe('provider_unavailable');
    }
  });
});
