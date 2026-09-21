import { Injectable } from '@nestjs/common';
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  RateLimitError,
  AuthenticationError,
  PermissionDeniedError,
  BadRequestError,
  UnprocessableEntityError,
  InternalServerError,
  APIError,
} from 'openai';
import { AramoError } from '@aramo/common';

import type { ProviderGenerateInput } from '../dto/provider-generate-input.dto.js';
import type { ProviderGenerateResult } from '../dto/provider-generate-result.dto.js';
import { SecretCacheService } from '../secrets/secret-cache.service.js';

import type { DraftProvider } from './draft-provider.interface.js';

// TENANT-LLM-2 §5 — OpenAI SDK adapter for the DraftProvider port. The SECOND
// wired provider (Phase A), behind the SAME provider-neutral port as Anthropic.
// Per ADR-0015: the adapter is the only vendor-specific surface; the substrate
// (service, dispatcher, redaction, port, result shape) is unchanged.
//
// Error translation mirrors AnthropicProvider EXACTLY (parity): the OpenAI SDK
// error classes fold to the SAME two AramoError codes + kinds so consumers see
// an identical failure surface regardless of the tenant's active provider.
@Injectable()
export class OpenAiProvider implements DraftProvider {
  constructor(private readonly secretCache: SecretCacheService) {}

  async generate(input: ProviderGenerateInput): Promise<ProviderGenerateResult> {
    // TENANT-LLM-1/2 — resolve THIS tenant's own OpenAI key and build a client
    // bound to it per call. No shared client → no cross-tenant key leak. A
    // not-configured tenant throws LlmKeyNotConfiguredError (fail-closed;
    // propagates to the governed "set a key" degradation — NEVER a
    // platform/cross-tenant/cross-provider fallback).
    const apiKey = await this.secretCache.getProviderApiKey(input.tenant_id, 'openai');
    const client = new OpenAI({ apiKey });

    try {
      const response = await client.chat.completions.create({
        model: input.model,
        max_tokens: input.max_tokens,
        messages: [
          ...(input.system_message !== undefined
            ? [{ role: 'system' as const, content: input.system_message }]
            : []),
          { role: 'user' as const, content: input.prompt },
        ],
      });

      const completion = response.choices[0]?.message?.content ?? '';

      return {
        completion,
        model_used: response.model,
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
        provider_request_id: response.id,
      };
    } catch (err: unknown) {
      throw this.translateOpenAiError(err);
    }
  }

  private translateOpenAiError(err: unknown): AramoError {
    const message = err instanceof Error ? err.message : String(err);

    if (err instanceof APIConnectionTimeoutError || err instanceof APIConnectionError) {
      return new AramoError('INTERNAL_ERROR', message, 502, {
        requestId: 'ai-draft-provider',
        details: { kind: 'provider_unavailable' },
      });
    }
    if (err instanceof RateLimitError) {
      return new AramoError('INTERNAL_ERROR', message, 429, {
        requestId: 'ai-draft-provider',
        details: { kind: 'provider_rate_limited' },
      });
    }
    if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
      return new AramoError('INTERNAL_ERROR', message, 500, {
        requestId: 'ai-draft-provider',
        details: { kind: 'provider_auth_failed' },
      });
    }
    if (err instanceof BadRequestError || err instanceof UnprocessableEntityError) {
      return new AramoError('VALIDATION_ERROR', message, 400, {
        requestId: 'ai-draft-provider',
        details: { kind: 'provider_input_invalid' },
      });
    }
    if (err instanceof InternalServerError) {
      return new AramoError('INTERNAL_ERROR', message, 502, {
        requestId: 'ai-draft-provider',
        details: { kind: 'provider_internal_error' },
      });
    }
    if (err instanceof APIError) {
      return new AramoError('INTERNAL_ERROR', message, 502, {
        requestId: 'ai-draft-provider',
        details: { kind: 'provider_internal_error' },
      });
    }
    return new AramoError('INTERNAL_ERROR', message, 502, {
      requestId: 'ai-draft-provider',
      details: { kind: 'provider_unknown_error' },
    });
  }
}
