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

import { SecretCacheService } from '../secrets/secret-cache.service.js';
import { isLlmKeyNotConfigured } from '../secrets/llm-key-not-configured.error.js';

import {
  type StructuredGenerationOutcome,
  type StructuredGenerationProvider,
  type StructuredGenerationRequest,
} from './structured-generation.types.js';

// TENANT-LLM-2 §5 — OpenAI adapter for the reusable structured-generation
// surface. Vendor-specific surface ONLY; maps to the SAME provider-neutral
// StructuredGenerationOutcome as the Anthropic adapter (grounding PARITY):
//   - reuses the per-(tenant,provider) secret custody (SecretCacheService) — no
//     second secret store, no second cache;
//   - STRICT_JSON_SCHEMA → `response_format: json_schema` (strict, constrained);
//     FORCED_TOOL → a single forced function tool whose parameters ARE the JSON
//     Schema (schema-guided; the consumer's shape validation/grounding is the
//     trust boundary — a tool/JSON response is NEVER trusted as correct here);
//   - is NON-STREAMING;
//   - never requests or reads reasoning; a `refusal` is treated as empty_output,
//     never surfaced as content;
//   - maps every failure to a SAFE category — NO raw upstream message text ever
//     leaves this method (parity with the Anthropic adapter's §23/§24).
@Injectable()
export class OpenAiStructuredGenerationService implements StructuredGenerationProvider {
  constructor(private readonly secretCache: SecretCacheService) {}

  providerKey(): string {
    return 'openai';
  }

  // TENANT-LLM-1/2 — build a client bound to THIS tenant's own OpenAI key. The
  // key (not the client) is cached per (tenant, provider); constructing a client
  // per call guarantees isolation (no shared client carrying one tenant's key
  // into another's request) and is rotation-correct. Throws
  // LlmKeyNotConfiguredError when the tenant has no OpenAI key.
  private async tenantClient(tenantId: string): Promise<OpenAI> {
    const apiKey = await this.secretCache.getProviderApiKey(tenantId, 'openai');
    return new OpenAI({ apiKey });
  }

  async generateStructured(request: StructuredGenerationRequest): Promise<StructuredGenerationOutcome> {
    let client: OpenAI;
    try {
      client = await this.tenantClient(request.tenant_id);
    } catch (err: unknown) {
      // A not-configured key is TERMINAL + fail-closed (governed "set a key";
      // NEVER a platform/cross-tenant/cross-provider fallback). A transient
      // Secrets Manager blip stays retryable (bounded) so it re-drives.
      if (isLlmKeyNotConfigured(err)) {
        return { kind: 'terminal', category: 'not_configured' };
      }
      return { kind: 'retryable', category: 'transport' };
    }
    const openai = client;

    const useForcedTool = request.transport === 'FORCED_TOOL';
    const name = safeName(request.schema_name);

    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = useForcedTool
        ? await openai.chat.completions.create({
            model: request.model,
            max_tokens: request.max_tokens,
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user_content },
            ],
            // ONE forced function tool whose parameters ARE the JSON Schema; the
            // model MUST call it, so its arguments are the sole structured output
            // we read. NO reasoning is requested.
            tools: [
              {
                type: 'function',
                function: {
                  name,
                  description: 'Return the structured extraction as this function’s arguments.',
                  parameters: request.json_schema,
                },
              },
            ],
            tool_choice: { type: 'function', function: { name } },
          })
        : await openai.chat.completions.create({
            model: request.model,
            max_tokens: request.max_tokens,
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user_content },
            ],
            // Native structured output: constrained decoding to the schema.
            response_format: {
              type: 'json_schema',
              json_schema: { name, schema: request.json_schema, strict: true },
            },
          });
    } catch (err: unknown) {
      return this.mapError(err);
    }

    const choice = response.choices[0];

    // Truncated generation → the JSON is incomplete. Distinct `truncated`
    // category so a consumer can surface an explicit "provider truncated" state.
    if (choice?.finish_reason === 'length') {
      return { kind: 'retryable', category: 'truncated' };
    }

    let parsed: unknown;
    if (useForcedTool) {
      // Consume ONLY the forced tool's arguments (a JSON string); ignore any
      // free-form assistant text. Downstream shape validation / grounding is the
      // trust boundary — a tool call is NOT proof the content is valid.
      const toolCall = choice?.message?.tool_calls?.[0];
      const args = toolCall?.function?.arguments;
      if (args === undefined || args.length === 0) {
        return { kind: 'terminal', category: 'empty_output' };
      }
      try {
        parsed = JSON.parse(args);
      } catch {
        return { kind: 'retryable', category: 'malformed_output' };
      }
    } else {
      // A refusal means the model declined — terminal, never surfaced as content.
      if (choice?.message?.refusal != null && choice.message.refusal.length > 0) {
        return { kind: 'terminal', category: 'empty_output' };
      }
      const content = choice?.message?.content ?? '';
      if (content.length === 0) {
        return { kind: 'terminal', category: 'empty_output' };
      }
      try {
        parsed = JSON.parse(content);
      } catch {
        // Constrained decoding should guarantee valid JSON; a parse miss is
        // treated as transient/malformed and retried (bounded).
        return { kind: 'retryable', category: 'malformed_output' };
      }
    }

    return {
      kind: 'ok',
      parsed,
      transport: {
        model_used: response.model,
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
        provider_request_id: response.id,
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
    // Unknown non-API error — retryable transport (bounded). No message text is
    // inspected or surfaced.
    return { kind: 'retryable', category: 'transport' };
  }
}

// OpenAI json_schema / function names must match ^[a-zA-Z0-9_-]{1,64}$ — derive a
// stable, safe name from the schema_name so it stays provenance-legible.
function safeName(schemaName: string): string {
  const safe = schemaName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return safe.length > 0 ? safe : 'structured_output';
}
