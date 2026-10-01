import { Injectable, Logger } from '@nestjs/common';
import { RequisitionEmbeddingRepository } from '@aramo/requisition';

import { EmbeddingProcessingConfig } from './embedding-processing.config.js';
import {
  RequisitionEmbeddingLifecycleService,
  type RequisitionEmbeddingDrainSummary,
} from './requisition-embedding-lifecycle.service.js';

export interface RequisitionEmbeddingRunSummary extends RequisitionEmbeddingDrainSummary {
  readonly enabled: boolean;
}

// Enterprise Search GS-2B — the Requisition embedding worker + dark reconcile sweep. Both are DARK by
// default (EMBEDDING_PROCESSING_ENABLED). reconcileOnce enqueues Requisitions lacking an embedding row
// (same-schema anti-join; churn-free — the lifecycle's idempotency short-circuits unchanged ones).
// runOnce drains the pending set. Terminal Requisitions are eligible (no state filter).
@Injectable()
export class RequisitionEmbeddingWorker {
  private readonly logger = new Logger(RequisitionEmbeddingWorker.name);

  constructor(
    private readonly lifecycle: RequisitionEmbeddingLifecycleService,
    private readonly repo: RequisitionEmbeddingRepository,
    private readonly config: EmbeddingProcessingConfig,
  ) {}

  async reconcileOnce(limit = 500): Promise<{ enabled: boolean; enqueued: number }> {
    if (!this.config.isEnabled()) return { enabled: false, enqueued: 0 };
    const refs = await this.repo.listReqsMissingEmbedding(limit);
    for (const ref of refs) await this.repo.enqueue(ref);
    if (refs.length > 0) this.logger.log(`requisition-embedding reconcile: enqueued ${refs.length} new Requisition(s)`);
    return { enabled: true, enqueued: refs.length };
  }

  async runOnce(batchSize = 20): Promise<RequisitionEmbeddingRunSummary> {
    if (!this.config.isEnabled()) return { enabled: false, claimed: 0, outcomes: {} };
    const summary = await this.lifecycle.drainOnce(batchSize);
    if (summary.claimed > 0) {
      this.logger.log(
        `requisition-embedding drain: claimed=${summary.claimed} outcomes=${JSON.stringify(summary.outcomes)}`,
      );
    }
    return { enabled: true, ...summary };
  }
}
