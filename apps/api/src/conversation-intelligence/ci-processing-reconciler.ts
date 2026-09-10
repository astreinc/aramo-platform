import { Inject, Injectable } from '@nestjs/common';
import { type AramoLogger } from '@aramo/common';
import { ConversationIntelligenceRunRepository } from '@aramo/conversation-intelligence';

import { CI_PROCESSING_RECONCILE_BATCH } from './ci-processing.queue.constants.js';
import { CiProcessingProducer } from './ci-processing.producer.js';

// CI-B6P §19 — bounded, restart-safe recovery. Closes the enqueue-after-commit
// loss gap: any durable run left `queued` or `failed_retryable` (crash before
// enqueue, enqueue publish failure, or a prior retry) is re-enqueued. Bounded
// per tick (CI_PROCESSING_RECONCILE_BATCH) — never an unbounded busy loop, and
// never a structured-log "outbox". Idempotent: re-enqueue converges (the worker
// short-circuits completed/terminal runs and processing is find-or-create).
@Injectable()
export class CiProcessingReconciler {
  constructor(
    private readonly runs: ConversationIntelligenceRunRepository,
    private readonly producer: CiProcessingProducer,
    @Inject('CiProcessingReconcilerLogger') private readonly logger: AramoLogger,
  ) {}

  async reconcile(): Promise<{ reEnqueued: number }> {
    const drivable = await this.runs.listReDrivableRuns(CI_PROCESSING_RECONCILE_BATCH);
    for (const run of drivable) {
      await this.producer.enqueueRun(run.id, run.tenant_id);
    }
    if (drivable.length > 0) {
      this.logger.log({ event: 'ci_processing_reconcile', re_enqueued: drivable.length });
    }
    return { reEnqueued: drivable.length };
  }
}
