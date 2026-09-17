import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';
import { TalentSkillCanonicalizationService } from '@aramo/talent-evidence';
import { RequisitionSkillCanonicalizationService } from '@aramo/requisition';
import {
  CANONICAL_RECONCILE_BACKSTOP_JOB,
  CANONICAL_RECONCILE_QUEUE_NAME,
  CanonicalReconcileProducer,
  type CanonicalReconcileJobData,
} from '@aramo/canonical-reconcile';

import { CanonicalReconcileBackstop } from './canonical-reconcile.backstop.js';

// SKILL-TAX Canonical Reconciliation Activation — the dedicated processor. Lives
// in apps/api (the only place that may legally consume BOTH the talent-evidence
// (scope:cip) and requisition (scope:ats) reconcile workers). Dispatches by job
// kind to the already-built, idempotent reconcile workers; the `backstop` job
// re-drives eligible missed talents. Retries rely on the workers' idempotency
// (duplicate delivery is harmless). manualRegistration + BullRegistrar.register()
// mirrors the platform processor pattern; self-schedules the backstop tick.
@Processor(CANONICAL_RECONCILE_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class CanonicalReconcileProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    private readonly talent: TalentSkillCanonicalizationService,
    private readonly requisition: RequisitionSkillCanonicalizationService,
    private readonly backstop: CanonicalReconcileBackstop,
    private readonly producer: CanonicalReconcileProducer,
    @Inject('CanonicalReconcileProcessorLogger') private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (job.name === CANONICAL_RECONCILE_BACKSTOP_JOB) {
      return this.backstop.run();
    }
    const data = job.data as CanonicalReconcileJobData;
    if (data.kind === 'TALENT') {
      return this.talent.reconcileTalent(data.tenant_id, data.talent_id);
    }
    return this.requisition.reconcileGoldenProfile(
      data.tenant_id,
      data.requisition_id,
      data.golden_profile_id,
    );
  }

  onApplicationBootstrap(): void {
    if (!this.redisConfig.isConfigured) {
      this.logger.warn({
        event: 'canonical_reconcile_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
    // Self-schedule the repeatable backstop tick (dedup by fixed jobId).
    void this.producer.scheduleBackstop();
  }
}
