import type { EmbeddingProvider } from './embedding-provider.js';

// Enterprise Search GS-2 P2 — the dedicated embedding boundary. SEPARATE from the text-generation
// provider port (directive §P2 / ruling 5): `embed(text) → vector + model metadata`, never
// overloading `generate(...)`. Exposed under a STRING token per the non-strict-lookup rule.
//
// The result carries enough model IDENTITY (provider, model, dimension) to establish
// compatibility/version — a caller persists these with the vector so a later model change is a
// detectable, rebuildable regeneration rather than a silent mismatch.
//
// Provider/model/tenant-key ABSENCE surfaces as EmbeddingUnavailableError — the caller degrades
// semantic retrieval to unavailable while GS-1 exact/lexical stays fully functional (directive
// "failure behavior"). This is distinct from a transient provider failure/timeout, which is also
// fail-soft at the caller.
export const EMBEDDING_PORT = 'EMBEDDING_PORT';

export interface EmbedInput {
  readonly tenant_id: string;
  readonly text: string;
  // Optional model override; honoured only if allowlisted for the resolved provider, else the
  // provider default (resolveEmbeddingModel).
  readonly model?: string;
}

export interface EmbedResult {
  readonly vector: number[];
  readonly provider: EmbeddingProvider;
  readonly model: string; // resolved + allowlisted
  readonly dimension: number; // === vector.length === EMBEDDING_MODEL_DIMENSION[model]
}

export interface EmbeddingPort {
  embed(input: EmbedInput): Promise<EmbedResult>;
}

// Raised when no embedding provider/model is configured for the tenant, or the tenant BYO key is
// absent. Semantic retrieval becomes unavailable; enterprise search stays available on exact +
// lexical. NOT thrown for a transient provider error (that is a distinct fail-soft path).
export class EmbeddingUnavailableError extends Error {
  constructor(reason: string) {
    super(`embedding unavailable: ${reason}`);
    this.name = 'EmbeddingUnavailableError';
  }
}
