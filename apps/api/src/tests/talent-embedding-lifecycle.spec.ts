import { describe, expect, it, vi } from 'vitest';
import { EmbeddingUnavailableError, type EmbeddingPort, type ActiveEmbeddingProviderResolver } from '@aramo/ai-draft';
import { canTalentEmbeddingTransition } from '@aramo/talent-embedding';
import type {
  TalentEmbeddingDescriptor,
  TalentEmbeddingRepositoryPort,
} from '@aramo/talent-embedding';

import { TalentEmbeddingLifecycleService } from '../embedding/talent-embedding-lifecycle.service.js';
import type { TalentEmbeddingConsentPort } from '../embedding/talent-embedding-consent.port.js';
import type { TalentEmbeddingFactsPort } from '../embedding/talent-embedding-facts.port.js';
import type { TalentSemanticFacts } from '../embedding/talent-semantic-document.js';

// GS-2 P5 — the Talent embedding lifecycle worker: consent-gated, idempotent, fail-closed, and it
// INVALIDATES (never leaves a stale vector) on a stable revocation or a no-longer-live subject —
// while a transient throw marks `failed` (retryable) WITHOUT invalidating.

const FACTS: TalentSemanticFacts = {
  title: 'Senior Data Engineer',
  key_skills: 'Java, AWS',
  current_employer: 'Acme',
  city: 'Reston',
  state: 'VA',
  work_history: [],
};
const MODEL = 'text-embedding-3-small';
const ITEM = { tenant_id: 't-1', talent_record_id: 'tr-1', site_id: null };

function build(opts: {
  consent?: Partial<Awaited<ReturnType<TalentEmbeddingConsentPort['evaluate']>>> | Error;
  facts?: TalentSemanticFacts | null;
  descriptor?: TalentEmbeddingDescriptor | null;
  embed?: 'ok' | Error;
}) {
  const consent: TalentEmbeddingConsentPort = {
    evaluate: vi.fn(async () => {
      if (opts.consent instanceof Error) throw opts.consent;
      return { allowed: true, ...(opts.consent ?? {}) } as Awaited<ReturnType<TalentEmbeddingConsentPort['evaluate']>>;
    }),
  };
  const facts: TalentEmbeddingFactsPort = {
    load: vi.fn(async () => (opts.facts === undefined ? FACTS : opts.facts)),
  };
  const repo: TalentEmbeddingRepositoryPort = {
    claimPending: vi.fn(async () => [ITEM]),
    enqueue: vi.fn(async () => undefined),
    getDescriptor: vi.fn(async () => opts.descriptor ?? null),
    saveReady: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    invalidate: vi.fn(async () => undefined),
  };
  const embedding: EmbeddingPort = {
    embed: vi.fn(async () => {
      if (opts.embed instanceof Error) throw opts.embed;
      return { vector: [0.1, 0.2], provider: 'openai', model: MODEL, dimension: 1536 };
    }),
  };
  const activeProvider: ActiveEmbeddingProviderResolver = {
    resolveActiveEmbeddingProvider: vi.fn(async () => 'openai' as const),
  };
  const service = new TalentEmbeddingLifecycleService(consent, facts, repo, embedding, activeProvider);
  return { service, consent, facts, repo, embedding };
}

describe('TalentEmbeddingLifecycleService (GS-2 P5)', () => {
  it('embeds and persists a ready vector for an allowed, live, changed subject', async () => {
    const { service, repo, embedding } = build({});
    expect(await service.processWorkItem(ITEM)).toBe('ready');
    expect(embedding.embed).toHaveBeenCalledOnce();
    expect(repo.saveReady).toHaveBeenCalledWith(
      expect.objectContaining({ talent_record_id: 'tr-1', embedding_model: MODEL, dimension: 1536, source_hash: expect.any(String) }),
    );
  });

  it('INVALIDATES on a stable consent revocation and never embeds', async () => {
    const { service, repo, embedding } = build({ consent: { allowed: false, reason: 'denied' } });
    expect(await service.processWorkItem(ITEM)).toBe('invalidated_consent');
    expect(repo.invalidate).toHaveBeenCalledWith({ tenant_id: 't-1', talent_record_id: 'tr-1' });
    expect(embedding.embed).not.toHaveBeenCalled();
  });

  it('SKIPS on an uncertain consent decision — leaves pending, does not invalidate', async () => {
    const { service, repo, embedding } = build({ consent: { allowed: false, reason: 'error' } });
    expect(await service.processWorkItem(ITEM)).toBe('skipped_consent_uncertain');
    expect(repo.invalidate).not.toHaveBeenCalled();
    expect(embedding.embed).not.toHaveBeenCalled();
  });

  it('invalidates when the subject is no longer live (facts null)', async () => {
    const { service, repo, embedding } = build({ facts: null });
    expect(await service.processWorkItem(ITEM)).toBe('invalidated_not_live');
    expect(repo.invalidate).toHaveBeenCalledOnce();
    expect(embedding.embed).not.toHaveBeenCalled();
  });

  it('is idempotent — no-op when already ready with the same source_hash and model', async () => {
    // First compute the source_hash the projection will produce for FACTS.
    const first = build({});
    await first.service.processWorkItem(ITEM);
    const savedHash = (first.repo.saveReady as unknown as { mock: { calls: [{ source_hash: string }][] } }).mock.calls[0][0].source_hash;

    const { service, embedding } = build({ descriptor: { status: 'ready', source_hash: savedHash, embedding_model: MODEL, dimension: 1536 } });
    expect(await service.processWorkItem(ITEM)).toBe('noop_idempotent');
    expect(embedding.embed).not.toHaveBeenCalled();
  });

  it('re-embeds when the persisted model differs (version-aware) even if source_hash matches', async () => {
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

  it('marks failed on a transient consent-authority throw — never invalidates a live vector', async () => {
    const { service, repo } = build({ consent: new Error('consent unavailable') });
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

  it('state machine allows only the sanctioned transitions', () => {
    expect(canTalentEmbeddingTransition('pending', 'ready')).toBe(true);
    expect(canTalentEmbeddingTransition('pending', 'failed')).toBe(true);
    expect(canTalentEmbeddingTransition('ready', 'pending')).toBe(true);
    expect(canTalentEmbeddingTransition('failed', 'pending')).toBe(true);
    expect(canTalentEmbeddingTransition('ready', 'failed')).toBe(false);
    expect(canTalentEmbeddingTransition('failed', 'ready')).toBe(false);
  });
});
