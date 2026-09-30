import { Inject, Injectable } from '@nestjs/common';
import {
  ACTIVE_EMBEDDING_PROVIDER_RESOLVER,
  EMBEDDING_PORT,
  EmbeddingUnavailableError,
  resolveEmbeddingModel,
  type ActiveEmbeddingProviderResolver,
  type EmbeddingPort,
} from '@aramo/ai-draft';
import {
  TALENT_EMBEDDING_REPOSITORY_PORT,
  type TalentEmbeddingRepositoryPort,
  type TalentEmbeddingWorkItem,
} from '@aramo/talent-embedding';

import { buildTalentSemanticDocument } from './talent-semantic-document.js';
import {
  TALENT_EMBEDDING_CONSENT_PORT,
  type TalentEmbeddingConsentPort,
} from './talent-embedding-consent.port.js';
import {
  TALENT_EMBEDDING_FACTS_PORT,
  type TalentEmbeddingFactsPort,
} from './talent-embedding-facts.port.js';

// Enterprise Search GS-2 P5 — the Talent embedding lifecycle worker core. Polling-outbox: claim
// pending work → process each idempotently. Per work item, in order:
//   1. ai_processing consent (P4, fail-closed). denied → INVALIDATE the vector (revocation);
//      an uncertain `error` decision → skip this attempt (leave pending, never invalidate).
//   2. Load authoritative recruiting facts (null → not a live subject → invalidate).
//   3. Build the deterministic P3 projection (empty → invalidate any stale vector).
//   4. Idempotency short-circuit: already `ready` with the SAME source_hash AND embedding_model →
//      no-op (never re-spends an embedding call for unchanged source under the same model).
//   5. Embed via EMBEDDING_PORT (dimension is validated inside the provider) → persist → `ready`.
// Any thrown error (transient embedding/consent-authority outage, EmbeddingUnavailableError from a
// missing tenant key) → mark `failed` (retryable) WITHOUT invalidating — a momentary outage must
// never masquerade as a revocation and delete a live vector.

export type TalentEmbeddingOutcome =
  | 'ready'
  | 'noop_idempotent'
  | 'invalidated_consent'
  | 'invalidated_not_live'
  | 'invalidated_empty_projection'
  | 'skipped_consent_uncertain'
  | 'failed'
  | 'failed_unavailable';

export interface TalentEmbeddingDrainSummary {
  readonly claimed: number;
  readonly outcomes: Readonly<Record<string, number>>;
}

@Injectable()
export class TalentEmbeddingLifecycleService {
  constructor(
    @Inject(TALENT_EMBEDDING_CONSENT_PORT)
    private readonly consent: TalentEmbeddingConsentPort,
    @Inject(TALENT_EMBEDDING_FACTS_PORT)
    private readonly facts: TalentEmbeddingFactsPort,
    @Inject(TALENT_EMBEDDING_REPOSITORY_PORT)
    private readonly repo: TalentEmbeddingRepositoryPort,
    @Inject(EMBEDDING_PORT)
    private readonly embedding: EmbeddingPort,
    @Inject(ACTIVE_EMBEDDING_PROVIDER_RESOLVER)
    private readonly activeProvider: ActiveEmbeddingProviderResolver,
  ) {}

  async drainOnce(batchSize = 20): Promise<TalentEmbeddingDrainSummary> {
    const items = await this.repo.claimPending(batchSize);
    const outcomes: Record<string, number> = {};
    for (const item of items) {
      const outcome = await this.processWorkItem(item);
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    }
    return { claimed: items.length, outcomes };
  }

  async processWorkItem(item: TalentEmbeddingWorkItem): Promise<TalentEmbeddingOutcome> {
    const { tenant_id, talent_record_id, site_id } = item;
    try {
      const consent = await this.consent.evaluate({ tenant_id, talent_record_id });
      if (!consent.allowed) {
        if (consent.reason === 'denied') {
          await this.repo.invalidate({ tenant_id, talent_record_id });
          return 'invalidated_consent';
        }
        // uncertain (`error`) — do NOT invalidate; leave pending for a later re-check.
        return 'skipped_consent_uncertain';
      }

      const facts = await this.facts.load({ tenant_id, talent_record_id });
      if (facts === null) {
        await this.repo.invalidate({ tenant_id, talent_record_id });
        return 'invalidated_not_live';
      }

      const { document, source_hash } = buildTalentSemanticDocument(facts);
      if (document === '') {
        await this.repo.invalidate({ tenant_id, talent_record_id });
        return 'invalidated_empty_projection';
      }

      const provider = await this.activeProvider.resolveActiveEmbeddingProvider(tenant_id);
      const model = resolveEmbeddingModel(provider);
      const current = await this.repo.getDescriptor({ tenant_id, talent_record_id });
      if (
        current?.status === 'ready' &&
        current.source_hash === source_hash &&
        current.embedding_model === model
      ) {
        return 'noop_idempotent';
      }

      const result = await this.embedding.embed({ tenant_id, text: document });
      await this.repo.saveReady({
        tenant_id,
        talent_record_id,
        site_id,
        vector: result.vector,
        source_hash,
        embedding_model: result.model,
        dimension: result.dimension,
      });
      return 'ready';
    } catch (err) {
      const error_message = err instanceof Error ? err.message : String(err);
      await this.repo.markFailed({ tenant_id, talent_record_id, error_message });
      return err instanceof EmbeddingUnavailableError ? 'failed_unavailable' : 'failed';
    }
  }
}
