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
  CompanyEmbeddingRepository,
  type CompanyEmbeddingWorkItem,
} from '@aramo/company';

import { buildCompanySemanticDocument } from './company-semantic-document.js';

// Enterprise Search GS-2C — the Company embedding lifecycle core. NO consent gate (companies are not
// Talent-consent subjects). Per work item: load org facts (null → invalidate) → build the projection
// (empty → invalidate) → idempotency short-circuit (same source_hash AND embedding_model) → embed →
// persist ready. Any throw → mark failed (retryable).

export type CompanyEmbeddingOutcome =
  | 'ready'
  | 'noop_idempotent'
  | 'invalidated_not_found'
  | 'invalidated_empty_projection'
  | 'failed'
  | 'failed_unavailable';

export interface CompanyEmbeddingDrainSummary {
  readonly claimed: number;
  readonly outcomes: Readonly<Record<string, number>>;
}

@Injectable()
export class CompanyEmbeddingLifecycleService {
  constructor(
    private readonly repo: CompanyEmbeddingRepository,
    @Inject(EMBEDDING_PORT) private readonly embedding: EmbeddingPort,
    @Inject(ACTIVE_EMBEDDING_PROVIDER_RESOLVER)
    private readonly activeProvider: ActiveEmbeddingProviderResolver,
  ) {}

  async drainOnce(batchSize = 20): Promise<CompanyEmbeddingDrainSummary> {
    const items = await this.repo.claimPending(batchSize);
    const outcomes: Record<string, number> = {};
    for (const item of items) {
      const outcome = await this.processWorkItem(item);
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    }
    return { claimed: items.length, outcomes };
  }

  async processWorkItem(item: CompanyEmbeddingWorkItem): Promise<CompanyEmbeddingOutcome> {
    const { tenant_id, company_id } = item;
    try {
      const facts = await this.repo.findSemanticFacts({ tenant_id, company_id });
      if (facts === null) {
        await this.repo.invalidate({ tenant_id, company_id });
        return 'invalidated_not_found';
      }

      const { document, source_hash } = buildCompanySemanticDocument({
        name: facts.name,
        industry: facts.industry,
        description: facts.description,
        key_technologies: facts.key_technologies,
        city: facts.city,
        state: facts.state,
        country: facts.country,
        ownership_type: facts.ownership_type,
        employee_count_band: facts.employee_count_band,
      });
      if (document === '') {
        await this.repo.invalidate({ tenant_id, company_id });
        return 'invalidated_empty_projection';
      }

      const provider = await this.activeProvider.resolveActiveEmbeddingProvider(tenant_id);
      const model = resolveEmbeddingModel(provider);
      const current = await this.repo.getDescriptor({ tenant_id, company_id });
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
        company_id,
        vector: result.vector,
        source_hash,
        embedding_model: result.model,
        dimension: result.dimension,
      });
      return 'ready';
    } catch (err) {
      const error_message = err instanceof Error ? err.message : String(err);
      await this.repo.markFailed({ tenant_id, company_id, error_message });
      return err instanceof EmbeddingUnavailableError ? 'failed_unavailable' : 'failed';
    }
  }
}
