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
  RequisitionEmbeddingRepository,
  type RequisitionEmbeddingWorkItem,
} from '@aramo/requisition';

import { buildRequisitionSemanticDocument } from './requisition-semantic-document.js';

// Enterprise Search GS-2B — the Requisition embedding lifecycle core. Simpler than the Talent
// lifecycle: NO ai_processing consent gate (directive ruling 2 — Requisition embeddings need no
// Talent consent). Per work item: load recruiting facts (null → invalidate) → build the P7
// commercial-excluded projection (empty → invalidate) → idempotency short-circuit (same source_hash
// AND embedding_model) → embed → persist ready. Any throw → mark failed (retryable). Terminal
// Requisitions are eligible (no lifecycle-state filter anywhere).

export type RequisitionEmbeddingOutcome =
  | 'ready'
  | 'noop_idempotent'
  | 'invalidated_not_found'
  | 'invalidated_empty_projection'
  | 'failed'
  | 'failed_unavailable';

export interface RequisitionEmbeddingDrainSummary {
  readonly claimed: number;
  readonly outcomes: Readonly<Record<string, number>>;
}

@Injectable()
export class RequisitionEmbeddingLifecycleService {
  constructor(
    private readonly repo: RequisitionEmbeddingRepository,
    @Inject(EMBEDDING_PORT) private readonly embedding: EmbeddingPort,
    @Inject(ACTIVE_EMBEDDING_PROVIDER_RESOLVER)
    private readonly activeProvider: ActiveEmbeddingProviderResolver,
  ) {}

  async drainOnce(batchSize = 20): Promise<RequisitionEmbeddingDrainSummary> {
    const items = await this.repo.claimPending(batchSize);
    const outcomes: Record<string, number> = {};
    for (const item of items) {
      const outcome = await this.processWorkItem(item);
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    }
    return { claimed: items.length, outcomes };
  }

  async processWorkItem(item: RequisitionEmbeddingWorkItem): Promise<RequisitionEmbeddingOutcome> {
    const { tenant_id, requisition_id } = item;
    try {
      const facts = await this.repo.findSemanticFacts({ tenant_id, requisition_id });
      if (facts === null) {
        await this.repo.invalidate({ tenant_id, requisition_id });
        return 'invalidated_not_found';
      }

      const { document, source_hash } = buildRequisitionSemanticDocument({
        title: facts.title,
        description: facts.description,
        type: facts.type,
        job_type: facts.job_type,
        role_family: facts.role_family,
        labor_category: facts.labor_category,
        seniority_level: facts.seniority_level,
        work_arrangement: facts.work_arrangement,
        work_authorization: facts.work_authorization,
        city: facts.city,
        state: facts.state,
      });
      if (document === '') {
        await this.repo.invalidate({ tenant_id, requisition_id });
        return 'invalidated_empty_projection';
      }

      const provider = await this.activeProvider.resolveActiveEmbeddingProvider(tenant_id);
      const model = resolveEmbeddingModel(provider);
      const current = await this.repo.getDescriptor({ tenant_id, requisition_id });
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
        requisition_id,
        vector: result.vector,
        source_hash,
        embedding_model: result.model,
        dimension: result.dimension,
      });
      return 'ready';
    } catch (err) {
      const error_message = err instanceof Error ? err.message : String(err);
      await this.repo.markFailed({ tenant_id, requisition_id, error_message });
      return err instanceof EmbeddingUnavailableError ? 'failed_unavailable' : 'failed';
    }
  }
}
