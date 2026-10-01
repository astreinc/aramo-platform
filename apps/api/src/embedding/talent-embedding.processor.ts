import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';

import { TalentEmbeddingReconcileService } from './talent-embedding-reconcile.service.js';
import { TalentEmbeddingWorker } from './talent-embedding.worker.js';
import { RequisitionEmbeddingWorker } from './requisition-embedding.worker.js';
import { TALENT_EMBEDDING_QUEUE_NAME } from './talent-embedding.queue.constants.js';

// Enterprise Search GS-2A Slice-5b — the talent-embedding worker. The SCHEDULES tick
// (registration.ts) enqueues a job; this worker (1) reconciles — enqueues new live Talents lacking
// an embedding row — then (2) drains the pending set (consent → facts → projection → embed →
// persist). Both steps are DARK by default (EMBEDDING_PROCESSING_ENABLED); the worker mirrors the
// lifecycle-poll processor (ADR-0018 Decision 1): manualRegistration + onApplicationBootstrap gate
// on RedisConnectionConfig — SILENT when Redis is unconfigured (CI / local dev). The reconcile +
// lifecycle services are exercised directly by their unit/integration proofs (no Redis).
@Processor(TALENT_EMBEDDING_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class TalentEmbeddingProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly reconcile: TalentEmbeddingReconcileService,
    // Named embeddingWorker (not `worker`) — WorkerHost already owns a `worker` member.
    private readonly embeddingWorker: TalentEmbeddingWorker,
    // GS-2B — the same dark tick also drives requisition reconcile + drain.
    private readonly requisitionWorker: RequisitionEmbeddingWorker,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('TalentEmbeddingProcessorLogger') private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    // Reconcile then drain, for both entity types. Every step no-ops when EMBEDDING_PROCESSING_ENABLED
    // is off (each worker/reconcile self-gates).
    await this.reconcile.runOnce();
    await this.embeddingWorker.runOnce();
    await this.requisitionWorker.reconcileOnce();
    await this.requisitionWorker.runOnce();
  }

  onApplicationBootstrap(): void {
    if (!this.redisConfig.isConfigured) {
      this.logger.warn({
        event: 'talent_embedding_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
