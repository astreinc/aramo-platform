import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';

import { PlacementLifecycleOrchestratorService } from './placement-lifecycle-orchestrator.service.js';
import {
  PLACEMENT_LIFECYCLE_QUEUE_NAME,
  PLACEMENT_LIFECYCLE_BATCH_SIZE,
} from './placement-lifecycle.queue.constants.js';

// Lane 2 / L2-G (Part 3, R-PROC) — the placement→pipeline lifecycle orchestrator worker.
// The SCHEDULES tick (registration.ts) enqueues a job; this worker drains a batch of
// not-yet-consumed placement.process.state_changed events through the idempotent inbox
// seam (PlacementLifecycleOrchestratorService.drainBatch). Lifecycle mirrors the other
// poll processors (ADR-0018 Decision 1): manualRegistration + onApplicationBootstrap gate
// on RedisConnectionConfig — SILENT when Redis is unconfigured (CI / local dev). The drain
// seam is exercised directly by the integration proofs (no Redis) via the service.
@Processor(PLACEMENT_LIFECYCLE_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class PlacementLifecycleOrchestratorProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly service: PlacementLifecycleOrchestratorService,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('PlacementLifecycleOrchestratorLogger')
    private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    const counts = await this.service.drainBatch({ limit: PLACEMENT_LIFECYCLE_BATCH_SIZE });
    this.logger.log({
      event: 'placement_lifecycle_orchestrator_tick_completed',
      job_id: job.id ?? null,
      ...counts,
    });
  }

  onApplicationBootstrap(): void {
    if (!this.redisConfig.isConfigured) {
      this.logger.warn({
        event: 'placement_lifecycle_orchestrator_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
