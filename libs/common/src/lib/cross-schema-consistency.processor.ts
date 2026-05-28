import { Inject, type OnApplicationBootstrap } from '@nestjs/common';
import { BullRegistrar, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { CrossSchemaConsistencyRepository } from './cross-schema-consistency.repository.js';
import { CROSS_SCHEMA_CONSISTENCY_QUEUE_NAME } from './cross-schema-consistency.queue.constants.js';
import { type AramoLogger } from './logging/index.js';
import { RedisConnectionConfig } from './redis/redis-connection.config.js';

// M5 PR-11 §4.4 — cross-schema consistency check BullMQ processor.
//
// Architecture v2.1 §9.2 / Plan v1.5 §M5 Track A item 6 binding. Scans
// 5 critical cross-schema reference pairs (audit Axis E Lead-Q-E1=(b)
// disposition; ADR-0018 Decision 7) and logs orphan counts + samples.
//
// PR-11 ships SCAN-ONLY (no remediation). Auto-fix logic deferred to
// M6/M7 ops-track per ADR-0018 Decision 7.
//
// Lifecycle mirrors libs/matching pattern (ADR-0018 Decision 1).

export interface CrossSchemaConsistencyScanInput {
  // Override the per-pair sample size (defaults to 10) for forensic logging.
  override_sample_size?: number;
}

const DEFAULT_SAMPLE_SIZE = 10;

@Processor(CROSS_SCHEMA_CONSISTENCY_QUEUE_NAME, {
  skipWaitingForReady: true,
  skipVersionCheck: true,
})
export class CrossSchemaConsistencyProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  constructor(
    private readonly repo: CrossSchemaConsistencyRepository,
    private readonly registrar: BullRegistrar,
    private readonly redisConfig: RedisConnectionConfig,
    @Inject('CrossSchemaConsistencyProcessorLogger')
    private readonly logger: AramoLogger,
  ) {
    super();
  }

  async process(job: Job<CrossSchemaConsistencyScanInput>): Promise<void> {
    const sampleSize = job.data.override_sample_size ?? DEFAULT_SAMPLE_SIZE;
    this.logger.log({
      event: 'cross_schema_consistency_scan_starting',
      job_id: job.id ?? null,
      sample_size: sampleSize,
    });

    const results = await this.repo.scanAll({ sample_size: sampleSize });
    const totalOrphans = results.reduce((acc, r) => acc + r.orphan_count, 0);

    if (totalOrphans > 0) {
      this.logger.warn({
        event: 'cross_schema_consistency_scan_orphans_found',
        job_id: job.id ?? null,
        total_orphan_count: totalOrphans,
        per_pair: results.map((r) => ({
          pair_id: r.pair_id,
          orphan_count: r.orphan_count,
          samples: r.samples,
        })),
      });
    } else {
      this.logger.log({
        event: 'cross_schema_consistency_scan_clean',
        job_id: job.id ?? null,
      });
    }
  }

  onApplicationBootstrap(): void {
    if (!this.redisConfig.isConfigured) {
      this.logger.warn({
        event: 'cross_schema_consistency_worker_unregistered',
        reason: 'redis_url_missing',
      });
      return;
    }
    this.registrar.register();
  }
}
