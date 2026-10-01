import { Injectable, Logger } from '@nestjs/common';
import { CompanyEmbeddingRepository } from '@aramo/company';

import { EmbeddingProcessingConfig } from './embedding-processing.config.js';
import {
  CompanyEmbeddingLifecycleService,
  type CompanyEmbeddingDrainSummary,
} from './company-embedding-lifecycle.service.js';

export interface CompanyEmbeddingRunSummary extends CompanyEmbeddingDrainSummary {
  readonly enabled: boolean;
}

// Enterprise Search GS-2C — the Company embedding worker + dark reconcile sweep. Both DARK by default
// (EMBEDDING_PROCESSING_ENABLED). reconcileOnce enqueues Companies lacking an embedding row (same-schema
// anti-join; churn-free via the lifecycle idempotency short-circuit). runOnce drains the pending set.
@Injectable()
export class CompanyEmbeddingWorker {
  private readonly logger = new Logger(CompanyEmbeddingWorker.name);

  constructor(
    private readonly lifecycle: CompanyEmbeddingLifecycleService,
    private readonly repo: CompanyEmbeddingRepository,
    private readonly config: EmbeddingProcessingConfig,
  ) {}

  async reconcileOnce(limit = 500): Promise<{ enabled: boolean; enqueued: number }> {
    if (!this.config.isEnabled()) return { enabled: false, enqueued: 0 };
    const refs = await this.repo.listCompaniesMissingEmbedding(limit);
    for (const ref of refs) await this.repo.enqueue(ref);
    if (refs.length > 0) this.logger.log(`company-embedding reconcile: enqueued ${refs.length} new Company(ies)`);
    return { enabled: true, enqueued: refs.length };
  }

  async runOnce(batchSize = 20): Promise<CompanyEmbeddingRunSummary> {
    if (!this.config.isEnabled()) return { enabled: false, claimed: 0, outcomes: {} };
    const summary = await this.lifecycle.drainOnce(batchSize);
    if (summary.claimed > 0) {
      this.logger.log(
        `company-embedding drain: claimed=${summary.claimed} outcomes=${JSON.stringify(summary.outcomes)}`,
      );
    }
    return { enabled: true, ...summary };
  }
}
