import type { EmbeddingProvider } from './embedding-provider.js';

// Enterprise Search GS-2 P2 — the port through which the embedding service learns a tenant's
// active embedding provider. DELIBERATELY SEPARATE from ActiveProviderResolver (chat): embedding
// selection is independent from `llm.active_provider` (ruling 5 — never infer the embedding
// provider from the chat provider). ai-draft owns this interface + token; apps/api binds a
// settings-backed implementation reading the `embedding.active_provider` KnownSetting (default
// 'openai'), so ai-draft never imports @aramo/settings (no lib→lib nx edge). Derives from the
// OWNED tenant_id only; ALWAYS returns a wired EmbeddingProvider.
export interface ActiveEmbeddingProviderResolver {
  resolveActiveEmbeddingProvider(tenantId: string): Promise<EmbeddingProvider>;
}

export const ACTIVE_EMBEDDING_PROVIDER_RESOLVER = 'ACTIVE_EMBEDDING_PROVIDER_RESOLVER';
