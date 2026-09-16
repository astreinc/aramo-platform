import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';

import { SKILL_CANONICALIZATION_QUEUE_NAME } from './skill-canonicalization.queue.constants.js';
import {
  SkillCanonicalizationService,
  type CanonicalizationResult,
} from './skill-canonicalization.service.js';

// M5 PR-11 §4.5 — skill-canonicalization BullMQ processor.
//
// SKILL-TAX-1C wires this processor (the M6/M7 execution seam the recon told us
// to fill, not park) to the deterministic SkillCanonicalizationService. The
// processor RESOLVES a batch of stated surface forms (+ optional explicit
// versions) to canonical Skill/version identities and returns the results.
//
// It is READ-ONLY at this phase: it persists NO downstream evidence. The
// batch-reconciliation TARGETS (IngestionRecord.skill_surface_forms and,
// post-HF2, TalentSkillEvidence) are cross-lib and are wired in SKILL-TAX-1D/1G
// — wiring them here now would cross the scope:ats boundary or depend on
// unmerged HF2 substrate. Because it only resolves, the job is deterministic,
// idempotent (re-running writes nothing), non-inferential, and safe on unknown
// skills (they return UNRESOLVED, the job still completes). It NEVER emits a
// related skill as a result.
//
// Lifecycle mirrors libs/matching pattern (ADR-0018 Decision 1). The scaffold
// mechanics the recon required are preserved: manualRegistration +
// BullRegistrar.register() in onApplicationBootstrap; existing queue/cron
// topology unchanged; no new queue or processor.

export interface SkillCanonicalizationScanItem {
  surfaceForm: string;
  explicitVersion?: string | null;
}

export interface SkillCanonicalizationScanInput {
  // The surface forms to resolve this run. Empty/absent => the job completes
  // with zero resolutions (the cron may enqueue an empty scan until 1D/1G feed
  // it real batches).
  items?: SkillCanonicalizationScanItem[];
}

export interface SkillCanonicalizationScanResult {
  total: number;
  resolved: number;
  unresolved: number;
  results: CanonicalizationResult[];
}

@Processor(SKILL_CANONICALIZATION_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class SkillCanonicalizationProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    private readonly canonicalization: SkillCanonicalizationService,
    @Inject('SkillCanonicalizationProcessorLogger')
    private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(
    job: Job<SkillCanonicalizationScanInput>,
  ): Promise<SkillCanonicalizationScanResult> {
    const items = job.data?.items ?? [];
    const results: CanonicalizationResult[] = [];
    for (const item of items) {
      // Deterministic, read-only resolution. No persistence, no inference.
      results.push(
        await this.canonicalization.resolve({
          surfaceForm: item.surfaceForm,
          explicitVersion: item.explicitVersion ?? null,
        }),
      );
    }
    const resolved = results.filter((r) => r.status === 'RESOLVED').length;
    const summary: SkillCanonicalizationScanResult = {
      total: results.length,
      resolved,
      unresolved: results.length - resolved,
      results,
    };
    this.logger.log({
      event: 'skill_canonicalization_scan_completed',
      job_id: job.id ?? null,
      total: summary.total,
      resolved: summary.resolved,
      unresolved: summary.unresolved,
    });
    return summary;
  }

  onApplicationBootstrap(): void {
    if (!this.redisConfig.isConfigured) {
      this.logger.warn({
        event: 'skill_canonicalization_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
