import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  embeddingModelDimension,
  isEmbeddingProvider,
  resolveEmbeddingModel,
} from '../lib/embedding/embedding-provider.js';
import { EmbeddingUnavailableError } from '../lib/embedding/embedding.port.js';
import { OpenAiEmbeddingProvider } from '../lib/embedding/openai-embedding.provider.js';
import type { ActiveEmbeddingProviderResolver } from '../lib/embedding/active-embedding-provider-resolver.js';
import type { SecretCacheService } from '../lib/secrets/secret-cache.service.js';
import { LlmKeyNotConfiguredError } from '../lib/secrets/llm-key-not-configured.error.js';

// GS-2 P2 — embedding governance + OpenAI adapter unit proofs. The OpenAI SDK is mocked so the
// adapter's contract (closed-allowlist model resolution, dimension validation, missing-key →
// EmbeddingUnavailableError, resolver-not-chat-provider) is asserted without a network call.

const { embeddingsCreate } = vi.hoisted(() => ({ embeddingsCreate: vi.fn() }));
vi.mock('openai', () => ({
  // A class default export is a genuine constructor for `new OpenAI(...)`; the adapter only uses
  // the default export, so mocking `default` alone is sufficient for this spec.
  default: class MockOpenAI {
    embeddings = { create: embeddingsCreate };
  },
}));

function vec(n: number): number[] {
  return new Array(n).fill(0.01);
}

describe('GS-2 P2 — embedding governance', () => {
  it('resolves the model through the closed allowlist (arbitrary input → provider default)', () => {
    expect(resolveEmbeddingModel('openai', 'attacker-model')).toBe('text-embedding-3-small');
    expect(resolveEmbeddingModel('openai', 'text-embedding-3-small')).toBe('text-embedding-3-small');
    expect(resolveEmbeddingModel('openai')).toBe('text-embedding-3-small');
  });
  it('declares the model dimension and rejects unknown models', () => {
    expect(embeddingModelDimension('text-embedding-3-small')).toBe(1536);
    expect(() => embeddingModelDimension('nope')).toThrow();
  });
  it('recognises only wired embedding providers', () => {
    expect(isEmbeddingProvider('openai')).toBe(true);
    expect(isEmbeddingProvider('anthropic')).toBe(false);
  });
});

describe('GS-2 P2 — OpenAiEmbeddingProvider', () => {
  let secretCache: { getProviderApiKey: ReturnType<typeof vi.fn> };
  let resolver: { resolveActiveEmbeddingProvider: ReturnType<typeof vi.fn> };
  let provider: OpenAiEmbeddingProvider;

  beforeEach(() => {
    embeddingsCreate.mockReset();
    secretCache = { getProviderApiKey: vi.fn().mockResolvedValue('sk-tenant') };
    resolver = { resolveActiveEmbeddingProvider: vi.fn().mockResolvedValue('openai') };
    provider = new OpenAiEmbeddingProvider(
      secretCache as unknown as SecretCacheService,
      resolver as unknown as ActiveEmbeddingProviderResolver,
    );
  });

  it('embeds via the resolved provider + allowlisted model, returning vector + model identity', async () => {
    embeddingsCreate.mockResolvedValue({ data: [{ embedding: vec(1536) }] });
    const r = await provider.embed({ tenant_id: 't-1', text: 'cloud data engineer' });
    expect(resolver.resolveActiveEmbeddingProvider).toHaveBeenCalledWith('t-1');
    expect(secretCache.getProviderApiKey).toHaveBeenCalledWith('t-1', 'openai');
    expect(embeddingsCreate).toHaveBeenCalledWith({ model: 'text-embedding-3-small', input: 'cloud data engineer' });
    expect(r).toEqual({ vector: vec(1536), provider: 'openai', model: 'text-embedding-3-small', dimension: 1536 });
  });

  it('ignores an arbitrary requested model (closed allowlist → default)', async () => {
    embeddingsCreate.mockResolvedValue({ data: [{ embedding: vec(1536) }] });
    await provider.embed({ tenant_id: 't-1', text: 'x', model: 'evil-model' });
    expect(embeddingsCreate).toHaveBeenCalledWith({ model: 'text-embedding-3-small', input: 'x' });
  });

  it('missing tenant key → EmbeddingUnavailableError (never a search failure), no provider call', async () => {
    secretCache.getProviderApiKey.mockRejectedValue(new LlmKeyNotConfiguredError('t-1'));
    await expect(provider.embed({ tenant_id: 't-1', text: 'x' })).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    expect(embeddingsCreate).not.toHaveBeenCalled();
  });

  it('rejects a dimension mismatch before returning (not EmbeddingUnavailableError)', async () => {
    embeddingsCreate.mockResolvedValue({ data: [{ embedding: vec(512) }] });
    const err = await provider.embed({ tenant_id: 't-1', text: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(EmbeddingUnavailableError);
    expect(String(err.message)).toMatch(/dimension mismatch/i);
  });
});
