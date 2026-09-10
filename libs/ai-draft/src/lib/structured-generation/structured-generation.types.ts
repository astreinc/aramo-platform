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

export interface StructuredGenerationRequest {
  /** Exact provider model id (allowlisted by the caller — never request-derived). */
  readonly model: string;
  /** Static system instructions (no evidence). */
  readonly system: string;
  /** The evidence payload (already minimized by the caller). */
  readonly user_content: string;
  readonly max_tokens: number;
  /** Provider-native JSON Schema for constrained decoding. */
  readonly json_schema: Record<string, unknown>;
  /** Stable schema name for provenance/telemetry. */
  readonly schema_name: string;
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
