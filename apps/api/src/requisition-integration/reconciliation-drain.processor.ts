import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';

import { RequisitionReconciliationDrainService } from './reconciliation-drain.service.js';
import { RECONCILIATION_DRAIN_QUEUE_NAME } from './reconciliation-drain.queue.constants.js';

// CB-D2-R (ADR-0030) — the reconciliation-drain worker. The SCHEDULES tick
// (registration.ts) enqueues a job; this worker claims a batch of due pending
// RequisitionExternalReconciliation rows and drains each through the governed
// path (RequisitionReconciliationDrainService.drainBatch). Lifecycle mirrors the
// other poll processors (ADR-0018 Decision 1): manualRegistration +
// onApplicationBootstrap gate on RedisConnectionConfig — SILENT when Redis is
// unconfigured (CI / local dev without Redis). The drain seam is exercised
// directly by the integration proofs (no Redis) via the service.
@Processor(RECONCILIATION_DRAIN_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class ReconciliationDrainProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly service: RequisitionReconciliationDrainService,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('ReconciliationDrainProcessorLogger')
    private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    const result = await this.service.drainBatch({ lockedBy: job.id ?? 'reconciliation-drain' });
    this.logger.log({
      event: 'reconciliation_drain_tick_completed',
      job_id: job.id ?? null,
      attempted: result.attempted,
      resolved: result.resolved,
      superseded: result.superseded,
      parked: result.parked,
      rescheduled: result.rescheduled,
      excluded: result.excluded,
    });
  }

  onApplicationBootstrap(): void {
    if (!this.redisConfig.isConfigured) {
      this.logger.warn({
        event: 'reconciliation_drain_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
