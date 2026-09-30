import { Inject, Injectable } from '@nestjs/common';
import OpenAI from 'openai';

import { SecretCacheService } from '../secrets/secret-cache.service.js';
import { LlmKeyNotConfiguredError } from '../secrets/llm-key-not-configured.error.js';

import {
  ACTIVE_EMBEDDING_PROVIDER_RESOLVER,
  type ActiveEmbeddingProviderResolver,
} from './active-embedding-provider-resolver.js';
import { embeddingModelDimension, resolveEmbeddingModel } from './embedding-provider.js';
import {
  EmbeddingUnavailableError,
  type EmbedInput,
  type EmbedResult,
  type EmbeddingPort,
} from './embedding.port.js';

// Enterprise Search GS-2 P2 — the OpenAI-backed EmbeddingPort (Phase A: the only wired embedding
// provider; Anthropic ships no embedding API). Mirrors the completion adapter's per-call,
// per-tenant key custody (no shared client → no cross-tenant leak); the substrate — port,
// governance, resolver, result shape — is provider-neutral so a second provider is additive.
//
// Invariants enforced here (directive §P2 / ruling refinements):
//   - the embedding provider is resolved from the OWNED tenant_id, NEVER inferred from the chat
//     provider;
//   - the model is resolved through the closed allowlist (resolveEmbeddingModel), never
//     request-derived;
//   - the returned vector length is checked against the declared model dimension BEFORE it is
//     handed back for persistence;
//   - a missing tenant key → EmbeddingUnavailableError (semantic degrades; enterprise search
//     stays available on exact + lexical), NEVER a platform/cross-tenant/cross-provider fallback.
@Injectable()
export class OpenAiEmbeddingProvider implements EmbeddingPort {
  constructor(
    private readonly secretCache: SecretCacheService,
    @Inject(ACTIVE_EMBEDDING_PROVIDER_RESOLVER)
    private readonly resolver: ActiveEmbeddingProviderResolver,
  ) {}

  async embed(input: EmbedInput): Promise<EmbedResult> {
    const provider = await this.resolver.resolveActiveEmbeddingProvider(input.tenant_id);
    const model = resolveEmbeddingModel(provider, input.model);
    const dimension = embeddingModelDimension(model);

    let apiKey: string;
    try {
      apiKey = await this.secretCache.getProviderApiKey(input.tenant_id, provider);
    } catch (err: unknown) {
      if (err instanceof LlmKeyNotConfiguredError) {
        throw new EmbeddingUnavailableError(`no ${provider} key configured for tenant`);
      }
      throw err;
    }

    const client = new OpenAI({ apiKey });
    const response = await client.embeddings.create({ model, input: input.text });
    const vector = response.data[0]?.embedding;
    if (vector === undefined) {
      throw new Error('embedding provider returned no vector');
    }
    if (vector.length !== dimension) {
      throw new Error(
        `embedding dimension mismatch: model ${model} expected ${dimension}, got ${vector.length}`,
      );
    }
    return { vector, provider, model, dimension };
  }
}
