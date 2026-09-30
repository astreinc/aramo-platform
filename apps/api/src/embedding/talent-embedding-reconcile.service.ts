import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  TALENT_EMBEDDING_REPOSITORY_PORT,
  type TalentEmbeddingRepositoryPort,
} from '@aramo/talent-embedding';

import { EmbeddingProcessingConfig } from './embedding-processing.config.js';

// Enterprise Search GS-2A Slice-5b — the DARK reconcile sweep (PO-ruled trigger mechanism). A
// boundary-clean apps/api job (no new lib→lib nx edge, and it avoids the consent→cip wall a direct
// consent hook would hit). It enqueues ONLY live Talents that have NO embedding row yet — never a
// blanket re-enqueue: re-enqueueing a `ready` row would flip it to `pending`, and the worker's
// idempotent-noop does not transition pending→ready, so a blanket sweep would churn/re-embed every
// cycle. New-Talent coverage is handled here; UPDATE re-embedding is deferred to event-driven
// triggers (post prod-attestation follow-up). Consent revocation needs no trigger — the worker
// re-checks ai_processing each drain and invalidates. DARK by default (EmbeddingProcessingConfig):
// a no-op until EMBEDDING_PROCESSING_ENABLED === 'true'.
@Injectable()
export class TalentEmbeddingReconcileService {
  private readonly logger = new Logger(TalentEmbeddingReconcileService.name);

  constructor(
    @Inject(TALENT_EMBEDDING_REPOSITORY_PORT)
    private readonly repo: TalentEmbeddingRepositoryPort,
    private readonly config: EmbeddingProcessingConfig,
  ) {}

  // Enqueue up to `limit` live Talents that have no embedding row yet. Returns the count enqueued.
  async runOnce(limit = 500): Promise<{ enabled: boolean; enqueued: number }> {
    if (!this.config.isEnabled()) return { enabled: false, enqueued: 0 };

    const refs = await this.repo.listLiveTalentRefsMissingEmbedding(limit);
    for (const ref of refs) {
      await this.repo.enqueue(ref);
    }
    if (refs.length > 0) {
      this.logger.log(`talent-embedding reconcile: enqueued ${refs.length} new live Talent(s)`);
    }
    return { enabled: true, enqueued: refs.length };
  }
}
