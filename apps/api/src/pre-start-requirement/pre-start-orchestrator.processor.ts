import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';

import { PreStartOrchestratorService } from './pre-start-orchestrator.service.js';
import {
  PRE_START_ORCHESTRATOR_QUEUE_NAME,
  PRE_START_ORCHESTRATOR_BATCH_SIZE,
} from './pre-start-orchestrator.queue.constants.js';

// Lane 5 / L5-P1 (E2 ignition) — the pre-start orchestrator worker. The SCHEDULES tick
// (jobs/registration.ts) enqueues a repeat job; this worker ignites the E2 seams
// (reconcile + intake materialize + terminal cancel) via PreStartOrchestratorService.tick.
// Lifecycle mirrors the offer-expiry / placement-lifecycle processors (ADR-0018 Decision 1):
// manualRegistration + onApplicationBootstrap gate on RedisConnectionConfig — SILENT when
// Redis is unconfigured (CI / local dev). The tick seam is exercised directly by the
// integration proofs (no Redis) via the service.
@Processor(PRE_START_ORCHESTRATOR_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class PreStartOrchestratorProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly service: PreStartOrchestratorService,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('PreStartOrchestratorLogger')
    private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    const counts = await this.service.tick(PRE_START_ORCHESTRATOR_BATCH_SIZE);
    this.logger.log({
      event: 'pre_start_orchestrator_tick_completed',
      job_id: job.id ?? null,
      ...counts,
    });
  }

  onApplicationBootstrap(): void {
    if (!this.redisConfig.isConfigured) {
      this.logger.warn({
        event: 'pre_start_orchestrator_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
