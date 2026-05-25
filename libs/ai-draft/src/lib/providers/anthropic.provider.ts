import { Injectable } from '@nestjs/common';
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  RateLimitError,
  AuthenticationError,
  BadRequestError,
  UnprocessableEntityError,
  APIError,
  InternalServerError,
} from '@anthropic-ai/sdk';
import { AramoError } from '@aramo/common';

import type { ProviderGenerateInput } from '../dto/provider-generate-input.dto.js';
import type { ProviderGenerateResult } from '../dto/provider-generate-result.dto.js';
import { SecretCacheService } from '../secrets/secret-cache.service.js';

import type { DraftProvider } from './draft-provider.interface.js';

// M5 PR-5 §4.6 — Anthropic SDK adapter for the DraftProvider port.
// Per ADR-0015 Decision 1: Anthropic-first, non-streaming messages API.
// The adapter is the only vendor-specific surface in the substrate —
// swapping LLM vendors replaces this file plus the secret-cache key
// suffix; the substrate (service, repository, redaction, port) remains
// unchanged.
//
// Error translation per directive §4.6: five Anthropic error classes
// fold to two AramoError codes (INTERNAL_ERROR for transport / rate /
// auth / vendor-internal; VALIDATION_ERROR for input-shape rejection).
// HTTP-status pairs follow the canonical mapping in
// libs/common/src/lib/errors/aramo-error.ts plus the directive's
// explicit overrides (e.g. INTERNAL_ERROR + status 502 for upstream
// transport failures).

@Injectable()
export class AnthropicProvider implements DraftProvider {
  private client: Anthropic | null = null;

  constructor(private readonly secretCache: SecretCacheService) {}

  async generate(input: ProviderGenerateInput): Promise<ProviderGenerateResult> {
    const apiKey = await this.secretCache.getAnthropicApiKey();

    if (this.client === null) {
      this.client = new Anthropic({ apiKey });
    }

    try {
      const message = await this.client.messages.create({
        model: input.model,
        max_tokens: input.max_tokens,
        messages: [{ role: 'user', content: input.prompt }],
        ...(input.system_message !== undefined ? { system: input.system_message } : {}),
      });

      const completion = message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');

      return {
        completion,
        model_used: message.model,
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
        provider_request_id: message.id,
      };
    } catch (err: unknown) {
      throw this.translateAnthropicError(err);
    }
  }

  private translateAnthropicError(err: unknown): AramoError {
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
    if (err instanceof AuthenticationError) {
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
