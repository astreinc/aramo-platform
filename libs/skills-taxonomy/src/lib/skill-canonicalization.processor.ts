import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type AramoLogger, RedisConnectionConfig } from '@aramo/common';

import { SKILL_CANONICALIZATION_QUEUE_NAME } from './skill-canonicalization.queue.constants.js';

// M5 PR-11 §4.5 — skill-canonicalization BullMQ processor.
//
// NO-OP FRAMEWORK at PR-11 per audit Axis F Lead-Q-F1=(c) disposition +
// ADR-0018 Decision 8. Meaningful canonicalization logic is deferred to
// the Skills Taxonomy workstream (M6/M7) because libs/skills-taxonomy
// currently has zero models (PR-1 scaffold only;
// libs/skills-taxonomy/prisma/schema.prisma:1-18) and SkillTaxonomy
// schema is unbuilt; surface forms are stored opaquely in
// libs/job-domain.GoldenProfile.skills (Json) +
// libs/ingestion.IngestionRecord.skill_surface_forms (Json).
//
// The processor ships now to honor D-ENT-READY-1 G7's 4-job structural
// binding ("the four Aramo Core BullMQ jobs ... implemented explicitly,
// each in the milestone owning its domain; not left implicit") — full
// deferral would close Track A item 6 WITHOUT all 4 jobs structurally
// present, violating the verbatim binding.
//
// Lifecycle mirrors libs/matching pattern (ADR-0018 Decision 1).

export interface SkillCanonicalizationScanInput {
  // Reserved for future per-tenant or scope overrides. Empty at PR-11.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reserved?: unknown;
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
    @Inject('SkillCanonicalizationProcessorLogger')
    private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(job: Job<SkillCanonicalizationScanInput>): Promise<void> {
    this.logger.log({
      event: 'skill_canonicalization_no_op_invoked',
      job_id: job.id ?? null,
      // The structural-only intent is captured in the log to make any
      // production "why is this empty?" investigation immediate.
      note:
        'Skill canonicalization job invoked; no-op at PR-11. ' +
        'Meaningful canonicalization deferred to Skills Taxonomy ' +
        'workstream (M6/M7) per ADR-0018 Decision 8 — libs/skills-taxonomy ' +
        'currently has zero models; SkillTaxonomy schema unbuilt.',
    });
    return Promise.resolve();
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
