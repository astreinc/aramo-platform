import { Injectable, Logger } from '@nestjs/common';

import { EmbeddingProcessingConfig } from './embedding-processing.config.js';
import {
  TalentEmbeddingLifecycleService,
  type TalentEmbeddingDrainSummary,
} from './talent-embedding-lifecycle.service.js';

export interface TalentEmbeddingRunSummary extends TalentEmbeddingDrainSummary {
  readonly enabled: boolean;
}

// Enterprise Search GS-2A — the polling-outbox worker entrypoint. A scheduler (BullMQ, wired in a
// later slice; dark until the PROD pgvector runtime is attested) calls runOnce on an interval;
// runOnce is a no-op unless EMBEDDING_PROCESSING_ENABLED === "true". The lifecycle service does the
// real per-item work (consent → facts → projection → embed → persist), idempotently.
@Injectable()
export class TalentEmbeddingWorker {
  private readonly logger = new Logger(TalentEmbeddingWorker.name);

  constructor(
    private readonly lifecycle: TalentEmbeddingLifecycleService,
    private readonly config: EmbeddingProcessingConfig,
  ) {}

  async runOnce(batchSize = 20): Promise<TalentEmbeddingRunSummary> {
    if (!this.config.isEnabled()) {
      return { enabled: false, claimed: 0, outcomes: {} };
    }
    const summary = await this.lifecycle.drainOnce(batchSize);
    if (summary.claimed > 0) {
      this.logger.log(
        `talent-embedding drain: claimed=${summary.claimed} outcomes=${JSON.stringify(summary.outcomes)}`,
      );
    }
    return { enabled: true, ...summary };
  }
}
