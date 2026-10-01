import { describe, expect, it, vi } from 'vitest';
import { EmbeddingUnavailableError, type EmbeddingPort, type ActiveEmbeddingProviderResolver } from '@aramo/ai-draft';
import type { RequisitionEmbeddingRepository, RequisitionSemanticFactsRow } from '@aramo/requisition';

import { RequisitionEmbeddingLifecycleService } from '../embedding/requisition-embedding-lifecycle.service.js';

// GS-2B — the Requisition embedding lifecycle: idempotent, version-aware, invalidate-when-gone; NO
// consent gate (directive ruling 2). A transient throw marks failed (retryable) without invalidating.

const FACTS: RequisitionSemanticFactsRow = {
  title: 'Senior Platform Engineer',
  description: 'Build and operate the data platform.',
  type: 'contract',
  job_type: 'contract_to_hire',
  role_family: 'software_engineering',
  labor_category: 'IT',
  seniority_level: 'senior',
  work_arrangement: 'hybrid',
  work_authorization: 'us_citizen',
  city: 'Reston',
  state: 'VA',
};
const MODEL = 'text-embedding-3-small';
const ITEM = { tenant_id: 't-1', requisition_id: 'r-1' };

function build(opts: {
  facts?: RequisitionSemanticFactsRow | null;
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
    listReqsMissingEmbedding: vi.fn(async () => []),
    searchSemanticForActor: vi.fn(async () => []),
  } as unknown as RequisitionEmbeddingRepository;
  const embedding = {
    embed: vi.fn(async () => {
      if (opts.embed instanceof Error) throw opts.embed;
      return { vector: [0.1, 0.2], provider: 'openai', model: MODEL, dimension: 1536 };
    }),
  } as unknown as EmbeddingPort;
  const activeProvider = {
    resolveActiveEmbeddingProvider: vi.fn(async () => 'openai' as const),
  } as unknown as ActiveEmbeddingProviderResolver;
  return { service: new RequisitionEmbeddingLifecycleService(repo, embedding, activeProvider), repo, embedding };
}

describe('RequisitionEmbeddingLifecycleService (GS-2B)', () => {
  it('embeds and persists a ready vector for a changed requisition', async () => {
    const { service, repo, embedding } = build({});
    expect(await service.processWorkItem(ITEM)).toBe('ready');
    expect(embedding.embed).toHaveBeenCalledOnce();
    expect(repo.saveReady).toHaveBeenCalledWith(
      expect.objectContaining({ requisition_id: 'r-1', embedding_model: MODEL, dimension: 1536, source_hash: expect.any(String) }),
    );
  });

  it('invalidates when the requisition is gone (facts null) and never embeds', async () => {
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

  it('re-embeds when the persisted model differs (version-aware)', async () => {
    const first = build({});
    await first.service.processWorkItem(ITEM);
    const savedHash = (first.repo.saveReady as unknown as { mock: { calls: [{ source_hash: string }][] } }).mock.calls[0][0].source_hash;
    const { service, embedding } = build({ descriptor: { status: 'ready', source_hash: savedHash, embedding_model: 'text-embedding-3-large', dimension: 3072 } });
    expect(await service.processWorkItem(ITEM)).toBe('ready');
    expect(embedding.embed).toHaveBeenCalledOnce();
  });

  it('marks failed (unavailable) when the tenant key is missing — does not invalidate', async () => {
    const { service, repo } = build({ embed: new EmbeddingUnavailableError('no key') });
    expect(await service.processWorkItem(ITEM)).toBe('failed_unavailable');
    expect(repo.markFailed).toHaveBeenCalledOnce();
    expect(repo.invalidate).not.toHaveBeenCalled();
  });

  it('marks failed (retryable) on a transient embedding error — does not invalidate', async () => {
    const { service, repo } = build({ embed: new Error('rate limited') });
    expect(await service.processWorkItem(ITEM)).toBe('failed');
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
