import { Injectable } from '@nestjs/common';
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  RateLimitError,
  AuthenticationError,
  PermissionDeniedError,
  BadRequestError,
  UnprocessableEntityError,
  InternalServerError,
  APIError,
} from '@anthropic-ai/sdk';

import { SecretCacheService } from '../secrets/secret-cache.service.js';

import {
  type StructuredGenerationOutcome,
  type StructuredGenerationProvider,
  type StructuredGenerationRequest,
} from './structured-generation.types.js';

// CI-B6P §4/§8/§9/§10/§23 — the Anthropic adapter for the reusable
// structured-generation surface. It is the ONLY vendor-specific file in this
// boundary. It:
//   - reuses the EXISTING Anthropic secret custody (SecretCacheService) — no
//     second secret store, no second cache (directive §5);
//   - uses NATIVE structured output via `output_config.format`
//     (type: json_schema) with constrained decoding (directive §8);
//   - is NON-STREAMING (directive §9);
//   - never requests or reads model reasoning/thinking; any thinking block in
//     the response is DISCARDED and never surfaced (directive §10);
//   - maps every provider failure to a SAFE category — NO raw upstream message
//     text ever leaves this method (directive §23/§24).
@Injectable()
export class AnthropicStructuredGenerationService implements StructuredGenerationProvider {
  private client: Anthropic | null = null;

  constructor(private readonly secretCache: SecretCacheService) {}

  providerKey(): string {
    return 'anthropic';
  }

  async generateStructured(request: StructuredGenerationRequest): Promise<StructuredGenerationOutcome> {
    let apiKey: string;
    try {
      apiKey = await this.secretCache.getAnthropicApiKey();
    } catch {
      // Secret resolution failed — safe, content-free. Retryable so a transient
      // Secrets Manager blip re-drives; persistent failure exhausts bounded
      // retries and escalates to intervention (never an infinite loop).
      return { kind: 'retryable', category: 'transport' };
    }

    if (this.client === null) {
      this.client = new Anthropic({ apiKey });
    }

    let message: Anthropic.Messages.Message;
    try {
      message = await this.client.messages.create({
        model: request.model,
        max_tokens: request.max_tokens,
        system: request.system,
        messages: [{ role: 'user', content: request.user_content }],
        // Native structured output (GA): constrained decoding to the schema.
        // NO thinking / reasoning is requested.
        output_config: {
          format: { type: 'json_schema', schema: request.json_schema },
        },
      });
    } catch (err: unknown) {
      return this.mapError(err);
    }

    // Truncated generation → the JSON is incomplete; retry (bounded).
    if (message.stop_reason === 'max_tokens') {
      return { kind: 'retryable', category: 'malformed_output' };
    }

    // Keep ONLY text content; discard any thinking/redacted-thinking or other
    // block types (directive §10 — reasoning never flows into CI handling).
    const text = message.content
      .filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    if (text.length === 0) {
      return { kind: 'terminal', category: 'empty_output' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Constrained decoding should guarantee valid JSON; a parse miss is
      // treated as transient/malformed and retried (bounded).
      return { kind: 'retryable', category: 'malformed_output' };
    }

    return {
      kind: 'ok',
      parsed,
      transport: {
        model_used: message.model,
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
        provider_request_id: message.id,
      },
    };
  }

  /** Map provider errors to SAFE categories — never leak upstream message text. */
  private mapError(err: unknown): StructuredGenerationOutcome {
    if (err instanceof APIConnectionTimeoutError) return { kind: 'retryable', category: 'timeout' };
    if (err instanceof APIConnectionError) return { kind: 'retryable', category: 'network' };
    if (err instanceof RateLimitError) return { kind: 'retryable', category: 'rate_limited' };
    if (err instanceof InternalServerError) return { kind: 'retryable', category: 'server_error' };
    if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
      return { kind: 'terminal', category: 'auth_config' };
    }
    if (err instanceof BadRequestError || err instanceof UnprocessableEntityError) {
      return { kind: 'terminal', category: 'invalid_request' };
    }
    if (err instanceof APIError) {
      const status = typeof err.status === 'number' ? err.status : 0;
      if (status >= 500) return { kind: 'retryable', category: 'server_error' };
      if (status === 429) return { kind: 'retryable', category: 'rate_limited' };
      return { kind: 'terminal', category: 'invalid_request' };
    }
    // Unknown non-API error — retryable transport (bounded); persistent →
    // intervention. No message text is inspected or surfaced.
    return { kind: 'retryable', category: 'transport' };
  }
}
