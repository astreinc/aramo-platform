import { describe, expect, it, vi } from 'vitest';
import { EmbeddingUnavailableError, type EmbeddingPort, type ActiveEmbeddingProviderResolver } from '@aramo/ai-draft';
import type { CompanyEmbeddingRepository, CompanySemanticFactsRow } from '@aramo/company';

import { CompanyEmbeddingLifecycleService } from '../embedding/company-embedding-lifecycle.service.js';

// GS-2C — the Company embedding lifecycle: idempotent, version-aware, invalidate-when-gone; NO consent
// gate. A transient throw marks failed (retryable) without invalidating.

const FACTS: CompanySemanticFactsRow = {
  name: 'Globex Corp',
  industry: 'Software',
  description: 'Cloud data platform.',
  key_technologies: 'Snowflake, Spark',
  city: 'Reston',
  state: 'VA',
  country: 'USA',
  ownership_type: 'private',
  employee_count_band: '201-500',
};
const MODEL = 'text-embedding-3-small';
const ITEM = { tenant_id: 't-1', company_id: 'co-1' };

function build(opts: {
  facts?: CompanySemanticFactsRow | null;
  descriptor?: { status: 'pending' | 'ready' | 'failed'; source_hash: string | null; embedding_model: string | null; dimension: number | null } | null;
  embed?: Error;
}) {
  const repo = {
    claimPending: vi.fn(async () => [ITEM]),
    findSemanticFacts: vi.fn(async () => (opts.facts === undefined ? FACTS : opts.facts)),
    getDescriptor: vi.fn(async () => opts.descriptor ?? null),
    saveReady: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    invalidate: vi.fn(async () => undefined),
    enqueue: vi.fn(async () => undefined),
    listCompaniesMissingEmbedding: vi.fn(async () => []),
    searchSemanticForActor: vi.fn(async () => []),
  } as unknown as CompanyEmbeddingRepository;
  const embedding = {
    embed: vi.fn(async () => {
      if (opts.embed instanceof Error) throw opts.embed;
      return { vector: [0.1, 0.2], provider: 'openai', model: MODEL, dimension: 1536 };
    }),
  } as unknown as EmbeddingPort;
  const activeProvider = {
    resolveActiveEmbeddingProvider: vi.fn(async () => 'openai' as const),
  } as unknown as ActiveEmbeddingProviderResolver;
  return { service: new CompanyEmbeddingLifecycleService(repo, embedding, activeProvider), repo, embedding };
}

describe('CompanyEmbeddingLifecycleService (GS-2C)', () => {
  it('embeds and persists a ready vector for a changed company', async () => {
    const { service, repo, embedding } = build({});
    expect(await service.processWorkItem(ITEM)).toBe('ready');
    expect(embedding.embed).toHaveBeenCalledOnce();
    expect(repo.saveReady).toHaveBeenCalledWith(
      expect.objectContaining({ company_id: 'co-1', embedding_model: MODEL, dimension: 1536, source_hash: expect.any(String) }),
    );
  });

  it('invalidates when the company is gone (facts null) and never embeds', async () => {
    const { service, repo, embedding } = build({ facts: null });
    expect(await service.processWorkItem(ITEM)).toBe('invalidated_not_found');
    expect(repo.invalidate).toHaveBeenCalledOnce();
    expect(embedding.embed).not.toHaveBeenCalled();
  });

  it('is idempotent — no-op when already ready with the same source_hash and model', async () => {
    const first = build({});
    await first.service.processWorkItem(ITEM);
    const savedHash = (first.repo.saveReady as unknown as { mock: { calls: [{ source_hash: string }][] } }).mock.calls[0][0].source_hash;
    const { service, embedding } = build({ descriptor: { status: 'ready', source_hash: savedHash, embedding_model: MODEL, dimension: 1536 } });
    expect(await service.processWorkItem(ITEM)).toBe('noop_idempotent');
    expect(embedding.embed).not.toHaveBeenCalled();
  });

  it('marks failed (unavailable) when the tenant key is missing — does not invalidate', async () => {
    const { service, repo } = build({ embed: new EmbeddingUnavailableError('no key') });
    expect(await service.processWorkItem(ITEM)).toBe('failed_unavailable');
    expect(repo.markFailed).toHaveBeenCalledOnce();
    expect(repo.invalidate).not.toHaveBeenCalled();
  });

  it('drainOnce claims a batch and aggregates outcomes', async () => {
    const { service } = build({});
    const summary = await service.drainOnce(10);
    expect(summary.claimed).toBe(1);
    expect(summary.outcomes.ready).toBe(1);
  });
});
