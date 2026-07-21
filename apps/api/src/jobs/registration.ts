import type { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { createAramoLogger, RedisConnectionConfig } from '@aramo/common';
import { STALE_CONSENT_QUEUE_NAME } from '@aramo/consent';
import { OUTBOX_PUBLISHER_QUEUE_NAME } from '@aramo/outbox-publisher';
import { CROSS_SCHEMA_CONSISTENCY_QUEUE_NAME } from '@aramo/common';
import { SKILL_CANONICALIZATION_QUEUE_NAME } from '@aramo/skills-taxonomy';
import { RESUME_REINDEX_QUEUE_NAME } from '@aramo/talent-record';
import { COLD_INGEST_EXTRACTION_QUEUE_NAME } from '@aramo/cold-ingest-extraction';

import { MATCH_SWEEP_QUEUE_NAME } from '../talent-anchor/match-sweep.queue.constants.js';
import { IDENTITY_DETECTION_QUEUE_NAME } from '../talent-identity/identity-detection.queue.constants.js';
import { CONSISTENCY_QUEUE_NAME } from '../talent-identity/consistency.queue.constants.js';
import { RECOMPUTE_SWEEP_QUEUE_NAME } from '../talent-identity/recompute-sweep.queue.constants.js';
import { IDENTITY_INDEX_LIFECYCLE_QUEUE_NAME } from '../talent-identity/identity-lifecycle-sweep.queue.constants.js';
import { JOB_DISTRIBUTION_SYNC_QUEUE_NAME } from '../job-distribution/job-distribution-sync.queue.constants.js';

// Application bootstrap registration for the repeating Aramo BullMQ jobs
// (Architecture v2.1 §9.2 / Plan v1.5 §M5 Track A item 6; doc/01 §13 anchor).
// Per Ruling 3 + ADR-0018 Decision 6, all repeating schedules use BullMQ-native
// `repeat` options (no @nestjs/schedule dependency).
//
// SRC-2 PR-3 — header count corrected: 12 repeat-scheduled queues here, of 16
// distinct BullMQ queues total (the other 4 — match, talent-reconcile,
// contradiction-detection, canonicalization-trigger — are enqueue/event-driven,
// not repeat-scheduled). The job-distribution-sync 300s tick is the 12th.
//
// Idempotent jobId on each `queue.add` prevents duplicate scheduling
// across pod restarts: BullMQ deduplicates repeat jobs by jobId.
//
// Gated by RedisConnectionConfig.isConfigured so that boot in environments
// without REDIS_URL (CI, local dev without Redis) is silent — the
// processors' own onApplicationBootstrap hooks log the unregistered state
// independently.

const SCHEDULES = [
  {
    queue_name: STALE_CONSENT_QUEUE_NAME,
    job_name: 'daily-scan',
    job_id: 'stale-consent-daily',
    repeat: { pattern: '0 3 * * *', tz: 'UTC' as const },
  },
  {
    queue_name: OUTBOX_PUBLISHER_QUEUE_NAME,
    job_name: 'tick',
    job_id: 'outbox-publisher-30s',
    repeat: { every: 30_000 },
  },
  {
    queue_name: CROSS_SCHEMA_CONSISTENCY_QUEUE_NAME,
    job_name: 'daily-scan',
    job_id: 'cross-schema-consistency-daily',
    repeat: { pattern: '0 4 * * *', tz: 'UTC' as const },
  },
  {
    queue_name: SKILL_CANONICALIZATION_QUEUE_NAME,
    job_name: 'daily-scan',
    job_id: 'skill-canonicalization-daily',
    repeat: { pattern: '0 5 * * *', tz: 'UTC' as const },
  },
  // Search PR-2 — the résumé re-extract tick. Drains `pending`
  // talent_resume_text rows (the polling-outbox signal written at the résumé-
  // attachment commit seam): S3 fetch + deterministic extract + D4 redaction +
  // persist. Every 60s — re-extract is search-infra, near-real-time is ample.
  {
    queue_name: RESUME_REINDEX_QUEUE_NAME,
    job_name: 'tick',
    job_id: 'resume-reindex-60s',
    repeat: { every: 60_000 },
  },
  // SRC-2 PR-1 — the cold-ingest extraction sweep. Drains resolved arrivals whose
  // résumé still needs extraction (identity evidence for promotion). Every 60s,
  // matching resume-reindex — the two are sibling résumé-extraction drains; a
  // large first-tick backlog processes by design (the deploy note reports the
  // count). Registered here so the SRC-1-webhook-originated arrivals are actually
  // swept (the worker existed but was never scheduled — SRC-2 recon finding).
  {
    queue_name: COLD_INGEST_EXTRACTION_QUEUE_NAME,
    job_name: 'tick',
    job_id: 'cold-ingest-extraction-60s',
    repeat: { every: 60_000 },
  },
  // TR-6 B1 (DDR §2) — the scheduled incremental match sweep. HOURLY (an engine
  // constant, not tenant config): re-match every ACTIVE subject with a new anchor
  // since its last_matched_at watermark. The gate is tenant-agnostic (batches all
  // tenants per query); the manual match-backfill CLI is the full-resweep escape hatch.
  {
    queue_name: MATCH_SWEEP_QUEUE_NAME,
    job_name: 'tick',
    job_id: 'match-sweep-hourly',
    repeat: { pattern: '0 * * * *', tz: 'UTC' as const },
  },
  // TR-6 B1 (DDR §7) — the daily read-only integrity-detection cron. Reports the
  // cheap detector classes (per-class counts + structured logs); mutates nothing.
  {
    queue_name: IDENTITY_DETECTION_QUEUE_NAME,
    job_name: 'tick',
    job_id: 'identity-detection-daily',
    repeat: { pattern: '0 6 * * *', tz: 'UTC' as const },
  },
  // TR-4 B3 (§3.1) — the hourly cross-source consistency detector poll. Re-checks
  // every ACTIVE subject with CLAIMS evidence added since its last_consistency_at
  // watermark; runs the three deterministic detectors over its cluster-union
  // CLAIMS evidence. Tenant-agnostic gate (batches all tenants); the manual
  // consistency-check CLI is the escape hatch.
  {
    queue_name: CONSISTENCY_QUEUE_NAME,
    job_name: 'tick',
    job_id: 'consistency-check-hourly',
    repeat: { pattern: '0 * * * *', tz: 'UTC' as const },
  },
  // TR-5 B1 (DDR §2) — the daily decay-recompute sweep. Re-prices every ACTIVE
  // subject whose TrustState is older than RECOMPUTE_STALENESS_DAYS and carries
  // decaying evidence, so a band goes honest on the clock's schedule rather than
  // only when some other write triggers a recompute. Time-driven (no watermark
  // column); tenant-agnostic gate (batches all tenants); the manual
  // recompute-sweep CLI is the escape hatch. Daily is ample — decay is gradual.
  {
    queue_name: RECOMPUTE_SWEEP_QUEUE_NAME,
    job_name: 'tick',
    job_id: 'trust-recompute-sweep-daily',
    repeat: { pattern: '0 7 * * *', tz: 'UTC' as const },
  },
  // TR-2b B2a (Directive §PR-1.3) — the daily identity-index lifecycle sweep.
  // Orphan purge (LIVE: clusters failing R4 liveness past ORPHAN_GRACE_DAYS) +
  // dormant detection (DARK: report-only behind DORMANT_LINK_MINTING_ENABLED).
  // Runs at 05:00 UTC, BEFORE the 06:00 detection report and 07:00 recompute
  // (engine cadence, not tenant config). The manual CLI is the escape hatch.
  {
    queue_name: IDENTITY_INDEX_LIFECYCLE_QUEUE_NAME,
    job_name: 'tick',
    job_id: 'identity-index-lifecycle-daily',
    repeat: { pattern: '0 5 * * *', tz: 'UTC' as const },
  },
  // SRC-2 PR-3 (R4) — the Indeed Job Sync freshness sweep. Every 300s: per enabled
  // tenant×'indeed', diff the publishable requisition set against ChannelPostingState
  // and drive create/update/expire mutations (bounded per-tick, fail-closed when
  // Indeed credentials are unset). Registered here so an enabled tenant is actually
  // swept; the worker itself is silent without Redis (CI / local dev).
  {
    queue_name: JOB_DISTRIBUTION_SYNC_QUEUE_NAME,
    job_name: 'tick',
    job_id: 'job-distribution-sync-300s',
    repeat: { every: 300_000 },
  },
] as const;

export async function registerBackgroundJobSchedules(app: INestApplication): Promise<void> {
  const logger = createAramoLogger('BackgroundJobScheduleRegistrar');
  const redisConfig = app.get(RedisConnectionConfig, { strict: false });

  if (!redisConfig.isConfigured) {
    logger.warn({
      event: 'background_jobs_unscheduled',
      reason: 'redis_url_missing',
    });
    return;
  }

  for (const schedule of SCHEDULES) {
    const queue = app.get<Queue>(getQueueToken(schedule.queue_name), { strict: false });
    await queue.add(schedule.job_name, {}, {
      jobId: schedule.job_id,
      repeat: schedule.repeat,
    });
    logger.log({
      event: 'background_job_scheduled',
      queue: schedule.queue_name,
      job_id: schedule.job_id,
    });
  }
}
