// Enterprise Search GS-2 P2 — the WIRED embedding providers + per-provider model/dimension
// policy. This is DELIBERATELY SEPARATE from the completion-LLM governance in
// ../providers/llm-provider.ts (directive §P2 / ruling 5): embedding-provider selection is
// independent from `llm.active_provider`. Self-contained (no @aramo/settings import) so
// ai-draft stays a settings leaf — the tenant's active-embedding-provider SELECTION is read
// via ActiveEmbeddingProviderResolver (apps/api provides the settings-backed impl).
//
// §4.5 no-dead-knobs: a provider appears here EXACTLY when its adapter is shipped + bound.
// Phase A embedding = OpenAI only (Anthropic ships no embedding API). The default model is
// text-embedding-3-small (1536-dim) — swappable behind EmbeddingPort; a model/dimension change
// is a re-embed + column migration, never a hot swap, because the vector column is sized to the
// dimension and the model identity is stored with every vector for compatibility/versioning.

/** The wired embedding providers (Phase A). */
export type EmbeddingProvider = 'openai';

export const WIRED_EMBEDDING_PROVIDERS: readonly EmbeddingProvider[] = Object.freeze(['openai']);

export function isEmbeddingProvider(value: unknown): value is EmbeddingProvider {
  return typeof value === 'string' && (WIRED_EMBEDDING_PROVIDERS as readonly string[]).includes(value);
}

// Per-provider embedding-model allowlist. Validated server-side; NEVER request-derived.
export const EMBEDDING_MODEL_ALLOWLIST: Readonly<Record<EmbeddingProvider, readonly string[]>> =
  Object.freeze({
    openai: Object.freeze(['text-embedding-3-small']),
  });

/** Per-provider default embedding model (head of each allowlist). */
export const EMBEDDING_PROVIDER_DEFAULT_MODEL: Readonly<Record<EmbeddingProvider, string>> =
  Object.freeze({
    openai: 'text-embedding-3-small',
  });

/** Fixed output dimension per model — the vector column is sized to this; part of model identity. */
export const EMBEDDING_MODEL_DIMENSION: Readonly<Record<string, number>> = Object.freeze({
  'text-embedding-3-small': 1536,
});

export function isEmbeddingModelAllowed(provider: EmbeddingProvider, model: string): boolean {
  return (EMBEDDING_MODEL_ALLOWLIST[provider] as readonly string[]).includes(model);
}

/**
 * Resolve the embedding model for a provider. Honour a requested model only when it is
 * allowlisted for the provider; otherwise the provider's default. The result is ALWAYS
 * allowlisted (never request-derived, never cross-provider).
 */
export function resolveEmbeddingModel(provider: EmbeddingProvider, requestedModel?: string): string {
  return requestedModel !== undefined && isEmbeddingModelAllowed(provider, requestedModel)
    ? requestedModel
    : EMBEDDING_PROVIDER_DEFAULT_MODEL[provider];
}

export function embeddingModelDimension(model: string): number {
  const dim = EMBEDDING_MODEL_DIMENSION[model];
  if (dim === undefined) {
    throw new Error(`unknown embedding model dimension for '${model}'`);
  }
  return dim;
}
