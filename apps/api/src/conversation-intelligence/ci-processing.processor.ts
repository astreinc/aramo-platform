import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';
import {
  CI_RUN_TERMINAL_STATUSES,
  ConversationIntelligenceProcessingService,
  ConversationIntelligenceRunRepository,
} from '@aramo/conversation-intelligence';

import { CiProcessingConfig } from './ci-processing.config.js';
import { CiProcessingProducer } from './ci-processing.producer.js';
import { CiProcessingReconciler } from './ci-processing-reconciler.js';
import {
  CI_PROCESSING_QUEUE_NAME,
  CI_PROCESSING_RECONCILE_JOB,
  type CiProcessingJobData,
} from './ci-processing.queue.constants.js';

// CI-B6P §21/§22 — the CI-processing worker. Two job kinds on one queue:
//   - `reconcile` → the bounded recovery scan (re-enqueue re-drivable runs);
//   - per-run     → load the durable run, gate on activation, then delegate to
//     the domain processing service (which performs the IMMEDIATE ai_processing
//     re-check right before the model call, runs the B6 validators, and persists
//     the immutable result). Terminal runs (completed/failed_terminal) are
//     short-circuited (idempotent replay). Redis-gated bootstrap (silent when
//     REDIS_URL is absent — CI/local). No content is ever logged.
@Processor(CI_PROCESSING_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class CiProcessingProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly config: CiProcessingConfig,
    private readonly runs: ConversationIntelligenceRunRepository,
    private readonly processing: ConversationIntelligenceProcessingService,
    private readonly producer: CiProcessingProducer,
    private readonly reconciler: CiProcessingReconciler,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('CiProcessingProcessorLogger') private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === CI_PROCESSING_RECONCILE_JOB) {
      await this.reconciler.reconcile();
      return;
    }

    const data = job.data as CiProcessingJobData;

    // Activation gate (dark by default) + fail-closed model config. When not
    // ready, leave the run queued (no model call); a config/flag fix + the
    // reconcile tick re-drive it. Directive §7/§22.
    if (!this.config.isReady()) {
      this.logger.warn({
        event: 'ci_processing_skipped',
        reason: this.config.isEnabled() ? 'config_invalid' : 'disabled',
        run_id: data.run_id,
        tenant_id: data.tenant_id,
      });
      return;
    }

    const run = await this.runs.findRunByIdInTenant(data.tenant_id, data.run_id);
    if (run === null) {
      this.logger.warn({ event: 'ci_processing_run_absent', run_id: data.run_id, tenant_id: data.tenant_id });
      return;
    }
    // Idempotent replay — never re-process an immutable terminal run.
    if (CI_RUN_TERMINAL_STATUSES.includes(run.status)) {
      return;
    }

    const result = await this.processing.process({
      tenant_id: run.tenant_id,
      conversation_transcript_id: run.conversation_transcript_id,
      requisition_analysis_context_snapshot_id: run.requisition_analysis_context_snapshot_id,
    });
    this.logger.log({
      event: 'ci_processing_processed',
      run_id: data.run_id,
      tenant_id: data.tenant_id,
      outcome: result.outcome,
      ...(result.error_code !== undefined ? { error_code: result.error_code } : {}),
    });
  }

  onApplicationBootstrap(): void {
    if (!this.redisConfig.isConfigured) {
      this.logger.warn({ event: 'ci_processing_worker_unregistered', reason: 'redis_url_missing' });
      return;
    }
    // Start the queue + worker (manualRegistration), then register the recovery
    // tick + do an immediate boot recovery pass.
    this.registrar.register();
    void this.producer.scheduleReconcile();
    void this.reconciler.reconcile();
  }
}
