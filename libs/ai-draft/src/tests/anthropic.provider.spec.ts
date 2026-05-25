import { describe, expect, it, vi } from 'vitest';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  RateLimitError,
  AuthenticationError,
  BadRequestError,
  UnprocessableEntityError,
  InternalServerError,
} from '@anthropic-ai/sdk';
import { AramoError } from '@aramo/common';

import { AnthropicProvider } from '../lib/providers/anthropic.provider.js';
import { SecretCacheService } from '../lib/secrets/secret-cache.service.js';

// M5 PR-5 §4.15 — AnthropicProvider unit spec. Validates happy-path
// shape mapping and the 5 error-class translations per directive §4.6.

interface InternalProvider {
  client: { messages: { create: ReturnType<typeof vi.fn> } } | null;
}

function withMockClient(
  provider: AnthropicProvider,
  create: ReturnType<typeof vi.fn>,
): void {
  (provider as unknown as InternalProvider).client = {
    messages: { create },
  };
}

function makeSecretCache(): SecretCacheService {
  const sc = new SecretCacheService();
  vi.spyOn(sc, 'getAnthropicApiKey').mockResolvedValue('sk-ant-test');
  return sc;
}

describe('AnthropicProvider', () => {
  it('maps successful response to ProviderGenerateResult', async () => {
    const provider = new AnthropicProvider(makeSecretCache());
    const create = vi.fn().mockResolvedValue({
      id: 'msg_01',
      model: 'claude-sonnet-4-6',
      content: [
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    withMockClient(provider, create);

    const result = await provider.generate({
      model: 'claude-sonnet-4-6',
      prompt: 'p',
      max_tokens: 100,
    });

    expect(result.completion).toBe('hello world');
    expect(result.model_used).toBe('claude-sonnet-4-6');
    expect(result.input_tokens).toBe(10);
    expect(result.output_tokens).toBe(5);
    expect(result.provider_request_id).toBe('msg_01');
  });

  it('translates APIConnectionError to INTERNAL_ERROR/provider_unavailable', async () => {
    const provider = new AnthropicProvider(makeSecretCache());
    withMockClient(
      provider,
      vi.fn().mockRejectedValue(new APIConnectionError({ message: 'down' } as never)),
    );
    try {
      await provider.generate({ model: 'm', prompt: 'p', max_tokens: 1 });
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AramoError);
      expect((e as AramoError).context.details?.['kind']).toBe('provider_unavailable');
      expect((e as AramoError).statusCode).toBe(502);
    }
  });

  it('translates APIConnectionTimeoutError to provider_unavailable', async () => {
    const provider = new AnthropicProvider(makeSecretCache());
    withMockClient(
      provider,
      vi.fn().mockRejectedValue(new APIConnectionTimeoutError({ message: 'timeout' } as never)),
    );
    try {
      await provider.generate({ model: 'm', prompt: 'p', max_tokens: 1 });
      expect.fail('expected throw');
    } catch (e) {
      expect((e as AramoError).context.details?.['kind']).toBe('provider_unavailable');
    }
  });

  it('translates RateLimitError to provider_rate_limited (429)', async () => {
    const provider = new AnthropicProvider(makeSecretCache());
    withMockClient(
      provider,
      vi.fn().mockRejectedValue(
        new RateLimitError(429, undefined, 'rate limited', new Headers()),
      ),
    );
    try {
      await provider.generate({ model: 'm', prompt: 'p', max_tokens: 1 });
      expect.fail('expected throw');
    } catch (e) {
      expect((e as AramoError).context.details?.['kind']).toBe('provider_rate_limited');
      expect((e as AramoError).statusCode).toBe(429);
    }
  });

  it('translates AuthenticationError to provider_auth_failed', async () => {
    const provider = new AnthropicProvider(makeSecretCache());
    withMockClient(
      provider,
      vi.fn().mockRejectedValue(
        new AuthenticationError(401, undefined, 'auth failed', new Headers()),
      ),
    );
    try {
      await provider.generate({ model: 'm', prompt: 'p', max_tokens: 1 });
      expect.fail('expected throw');
    } catch (e) {
      expect((e as AramoError).context.details?.['kind']).toBe('provider_auth_failed');
    }
  });

  it('translates BadRequestError to VALIDATION_ERROR/provider_input_invalid', async () => {
    const provider = new AnthropicProvider(makeSecretCache());
    withMockClient(
      provider,
      vi.fn().mockRejectedValue(
        new BadRequestError(400, undefined, 'bad input', new Headers()),
      ),
    );
    try {
      await provider.generate({ model: 'm', prompt: 'p', max_tokens: 1 });
      expect.fail('expected throw');
    } catch (e) {
      expect((e as AramoError).code).toBe('VALIDATION_ERROR');
      expect((e as AramoError).context.details?.['kind']).toBe('provider_input_invalid');
    }
  });

  it('translates UnprocessableEntityError to VALIDATION_ERROR/provider_input_invalid', async () => {
    const provider = new AnthropicProvider(makeSecretCache());
    withMockClient(
      provider,
      vi.fn().mockRejectedValue(
        new UnprocessableEntityError(422, undefined, 'unprocessable', new Headers()),
      ),
    );
    try {
      await provider.generate({ model: 'm', prompt: 'p', max_tokens: 1 });
      expect.fail('expected throw');
    } catch (e) {
      expect((e as AramoError).code).toBe('VALIDATION_ERROR');
      expect((e as AramoError).context.details?.['kind']).toBe('provider_input_invalid');
    }
  });

  it('translates InternalServerError to provider_internal_error (502)', async () => {
    const provider = new AnthropicProvider(makeSecretCache());
    withMockClient(
      provider,
      vi.fn().mockRejectedValue(
        new InternalServerError(500, undefined, 'vendor 500', new Headers()),
      ),
    );
    try {
      await provider.generate({ model: 'm', prompt: 'p', max_tokens: 1 });
      expect.fail('expected throw');
    } catch (e) {
      expect((e as AramoError).context.details?.['kind']).toBe('provider_internal_error');
      expect((e as AramoError).statusCode).toBe(502);
    }
  });
});
