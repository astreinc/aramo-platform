// CI-B6P §4 — the reusable, provider-NEUTRAL structured-generation surface
// exposed by libs/ai-draft. It exists so a consumer (apps/api CI composition)
// can obtain native structured JSON output from the sanctioned Anthropic
// infrastructure WITHOUT deep-importing ai-draft internals and WITHOUT any
// Anthropic SDK type crossing the boundary. The request carries a plain JSON
// Schema; the outcome carries parsed JSON + safe transport metadata + safe
// error categories only (NO raw provider message text, NO reasoning).

/** Safe, provider-neutral error categories (NO upstream message text). */
export type StructuredGenerationErrorCategory =
  // retryable
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'network'
  | 'malformed_output'
  // Output truncated at max_tokens (stop_reason=max_tokens) — the JSON is
  // incomplete. Distinct from malformed_output so a consumer can surface an
  // explicit "provider truncated" state (HF1 §13/R9) vs. a schema/parse miss.
  | 'truncated'
  | 'transport'
  // terminal
  | 'auth_config'
  | 'invalid_request'
  | 'empty_output';

/** Safe transport metadata (no content). */
export interface StructuredGenerationTransport {
  readonly model_used: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly provider_request_id?: string;
}

// Transport mechanism for the structured call.
//   STRICT_JSON_SCHEMA — native structured output (output_config.format,
//     constrained decoding, directive §8). The DEFAULT for all consumers.
//   FORCED_TOOL — schema-guided function-calling (one forced tool whose
//     input_schema IS the JSON Schema). Used ONLY where the schema is too large
//     for strict grammar compilation (HF2 v3 résumé draft). Schema-GUIDED, not
//     grammar-CONSTRAINED → the consumer's shape validation/grounding is the
//     trust boundary. There is NO implicit fallback between the two: a consumer
//     explicitly opts into FORCED_TOOL; a strict failure never silently retries
//     as a tool call.
export type StructuredGenerationTransportMode = 'STRICT_JSON_SCHEMA' | 'FORCED_TOOL';

export interface StructuredGenerationRequest {
  /** Exact provider model id (allowlisted by the caller — never request-derived). */
  readonly model: string;
  /** Static system instructions (no evidence). */
  readonly system: string;
  /** The evidence payload (already minimized by the caller). */
  readonly user_content: string;
  readonly max_tokens: number;
  /** Provider-native JSON Schema (constrained-decoding grammar / tool input_schema). */
  readonly json_schema: Record<string, unknown>;
  /** Stable schema name for provenance/telemetry. */
  readonly schema_name: string;
  /** Transport mechanism. Omitted ⇒ STRICT_JSON_SCHEMA (the safe default). */
  readonly transport?: StructuredGenerationTransportMode;
}

export type StructuredGenerationOutcome =
  | { readonly kind: 'ok'; readonly parsed: unknown; readonly transport: StructuredGenerationTransport }
  | { readonly kind: 'retryable'; readonly category: StructuredGenerationErrorCategory }
  | { readonly kind: 'terminal'; readonly category: StructuredGenerationErrorCategory };

/**
 * Provider-neutral structured-generation port. The Anthropic implementation is
 * the ONLY vendor-specific surface; consumers depend on this interface + token.
 */
export interface StructuredGenerationProvider {
  providerKey(): string;
  generateStructured(request: StructuredGenerationRequest): Promise<StructuredGenerationOutcome>;
}

export const STRUCTURED_GENERATION_PROVIDER = 'STRUCTURED_GENERATION_PROVIDER';
