import type { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { createAramoLogger, RedisConnectionConfig } from '@aramo/common';
import { STALE_CONSENT_QUEUE_NAME } from '@aramo/consent';
import { OUTBOX_PUBLISHER_QUEUE_NAME } from '@aramo/outbox-publisher';
import { CROSS_SCHEMA_CONSISTENCY_QUEUE_NAME } from '@aramo/common';
import { SKILL_CANONICALIZATION_QUEUE_NAME } from '@aramo/skills-taxonomy';
import {
  RESUME_REINDEX_QUEUE_NAME,
  RESUME_EXTRACTION_DRAFT_QUEUE_NAME,
} from '@aramo/talent-record';
import { COLD_INGEST_EXTRACTION_QUEUE_NAME } from '@aramo/cold-ingest-extraction';

import { IDENTITY_INDEX_LIFECYCLE_QUEUE_NAME } from '../talent-identity/identity-lifecycle-sweep.queue.constants.js';
import { JOB_DISTRIBUTION_SYNC_QUEUE_NAME } from '../job-distribution/job-distribution-sync.queue.constants.js';
import {
  LIFECYCLE_POLL_QUEUE_NAME,
  LIFECYCLE_POLL_INTERVAL_MS,
} from '../requisition-integration/lifecycle-poll.queue.constants.js';
import {
  RECONCILIATION_DRAIN_QUEUE_NAME,
  RECONCILIATION_DRAIN_INTERVAL_MS,
} from '../requisition-integration/reconciliation-drain.queue.constants.js';
import {
  TALENT_EMBEDDING_QUEUE_NAME,
  TALENT_EMBEDDING_TICK_INTERVAL_MS,
} from '../embedding/talent-embedding.queue.constants.js';
import {
  OFFER_EXPIRY_QUEUE_NAME,
  OFFER_EXPIRY_INTERVAL_MS,
} from '../offer/offer-expiry.queue.constants.js';
import {
  PLACEMENT_LIFECYCLE_QUEUE_NAME,
  PLACEMENT_LIFECYCLE_INTERVAL_MS,
} from '../placement-pipeline-orchestration/placement-lifecycle.queue.constants.js';
import {
  PRE_START_ORCHESTRATOR_QUEUE_NAME,
  PRE_START_ORCHESTRATOR_INTERVAL_MS,
} from '../pre-start-requirement/pre-start-orchestrator.queue.constants.js';

// Application bootstrap registration for the repeating Aramo BullMQ jobs
// (Architecture v2.1 §9.2 / Plan v1.5 §M5 Track A item 6; doc/01 §13 anchor).
// Per Ruling 3 + ADR-0018 Decision 6, all repeating schedules use BullMQ-native
// `repeat` options (no @nestjs/schedule dependency).
//
// SRC-2 PR-3 — header count corrected: 12 repeat-scheduled queues here, of 16
// distinct BullMQ queues total (the other 4 — match, talent-reconcile,
// contradiction-detection, canonicalization-trigger — are enqueue/event-driven,
// not repeat-scheduled). The job-distribution-sync 300s tick is the 12th.
// ATI-SEP-1 T10 WP1 — the talent-reconcile + contradiction-detection queues were
// deleted with libs/talent-reconcile (neither was repeat-scheduled here).
// CB-D2-A1 — the lifecycle-poll 300s tick is the 13th repeat-scheduled queue
// (of 18 distinct BullMQ queues total: +lifecycle-poll here, +connector-execution
// which is enqueue-driven, not repeat-scheduled).
// CB-D2-R — the reconciliation-drain 300s tick is the 14th repeat-scheduled queue
// (of 19 distinct BullMQ queues total: +reconciliation-drain here).
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
  // Search PR-2 — the resume re-extract tick. Drains `pending`
  // talent_resume_text rows (the polling-outbox signal written at the resume-
  // attachment commit seam): S3 fetch + deterministic extract + D4 redaction +
  // persist. Every 60s — re-extract is search-infra, near-real-time is ample.
  {
    queue_name: RESUME_REINDEX_QUEUE_NAME,
    job_name: 'tick',
    job_id: 'resume-reindex-60s',
    repeat: { every: 60_000 },
  },
  // Existing-Talent ATTACHMENT drain (repairing stranded PROCESSING drafts).
  // Every 60s. (ADR-0033 cutover: Talent Intake no longer rides this worker —
  // it flows outbox → EventBridge → SQS → Lambda; the former BullMQ relay tick
  // + the intake safety-net drain were retired.)
  {
    queue_name: RESUME_EXTRACTION_DRAFT_QUEUE_NAME,
    job_name: 'tick',
    job_id: 'resume-extraction-draft-60s',
    repeat: { every: 60_000 },
  },
  // Enterprise Search GS-2A Slice-5b — the talent-embedding tick. Every 300s: reconcile (enqueue new
  // live Talents lacking an embedding row) then drain the pending set (consent → projection → embed →
  // persist). DARK by default (EMBEDDING_PROCESSING_ENABLED) even with Redis configured; silent
  // without Redis (CI / local dev). No embedding is generated + no vector table is required until the
  // PROD pgvector runtime is attested + the GS-2A migration applied.
  {
    queue_name: TALENT_EMBEDDING_QUEUE_NAME,
    job_name: 'tick',
    job_id: 'talent-embedding-300s',
    repeat: { every: TALENT_EMBEDDING_TICK_INTERVAL_MS },
  },
  // SRC-2 PR-1 — the cold-ingest extraction sweep. Drains resolved arrivals whose
  // resume still needs extraction (identity evidence for promotion). Every 60s,
  // matching resume-reindex — the two are sibling resume-extraction drains; a
  // large first-tick backlog processes by design (the deploy note reports the
  // count). Registered here so the SRC-1-webhook-originated arrivals are actually
  // swept (the worker existed but was never scheduled — SRC-2 recon finding).
  {
    queue_name: COLD_INGEST_EXTRACTION_QUEUE_NAME,
    job_name: 'tick',
    job_id: 'cold-ingest-extraction-60s',
    repeat: { every: 60_000 },
  },
  // ATI-SEP-1 T10 WP2 — the TR-6 hourly match sweep + daily identity-detection
  // cron were removed (within-tenant duplicate detection is the ATS talent-event
  // handler now).
  // ATI-SEP-1 T10 WP3b — the TR-4 consistency poll, TR-5 decay-recompute sweep
  // and G1 recompute-repair schedules were removed (Talent Intelligence owns trust).
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
  // CB-D2-A1 (ADR-0030, R-PRODUCER) — the lifecycle-poll sweep. Every 300s: per
  // ACTIVE lifecycle-capable connection, fetch → raw-persist → ingress each
  // observation/event through the L1-D1 governed seam → advance the cursor only
  // after success. Registered here so an enabled connection is actually swept; the
  // worker itself is silent without Redis (CI / local dev). Provider-neutral in
  // A1 — the registry ships empty until a real lifecycle source is registered.
  {
    queue_name: LIFECYCLE_POLL_QUEUE_NAME,
    job_name: 'tick',
    job_id: 'lifecycle-poll-300s',
    repeat: { every: LIFECYCLE_POLL_INTERVAL_MS },
  },
  // CB-D2-R (ADR-0030) — the reconciliation-drain sweep. Every 300s: claim a
  // batch of due pending RequisitionExternalReconciliation rows (the rows A1 + FG
  // only WRITE today) and drain each through the governed path — re-resolve
  // identity + mapping → executeExternalLifecycleCommand → resolve, or park after
  // bounded attempts. Registered here so pending rows are actually drained; the
  // worker itself is silent without Redis (CI / local dev). The 14th
  // repeat-scheduled queue.
  {
    queue_name: RECONCILIATION_DRAIN_QUEUE_NAME,
    job_name: 'tick',
    job_id: 'reconciliation-drain-300s',
    repeat: { every: RECONCILIATION_DRAIN_INTERVAL_MS },
  },
  // L2-G (Part 3) — the placement→pipeline lifecycle orchestrator sweep. Every 300s:
  // drain a batch of not-yet-consumed placement.process.state_changed events →
  // reserve (idempotent inbox) → resolve submittal→pipeline lineage → drive the
  // Pipeline system command (COMPLETE on STARTED / dispositionDownstream on
  // FELL_THROUGH·NO_SHOW) → markProcessed(outcome). Silent without Redis (CI / local
  // dev); the drain seam is proven directly via the service. The 15th repeat queue.
  {
    queue_name: PLACEMENT_LIFECYCLE_QUEUE_NAME,
    job_name: 'tick',
    job_id: 'placement-lifecycle-orchestration-300s',
    repeat: { every: PLACEMENT_LIFECYCLE_INTERVAL_MS },
  },
  // L4 / P6 — the offer auto-expiry sweep. Every 300s: transition every overdue
  // SENT/NEGOTIATION offer (offer_expires_at < now) to EXPIRED — system-initiated,
  // legality-enforced (only SENT/NEGOTIATION carry an EXPIRED edge), CAS/idempotent,
  // audited (OfferEvent + OutboxEvent). Silent without Redis (CI / local dev); the
  // sweep seam is proven directly via OfferExpiryProducer.
  {
    queue_name: OFFER_EXPIRY_QUEUE_NAME,
    job_name: 'tick',
    job_id: 'offer-expiry-300s',
    repeat: { every: OFFER_EXPIRY_INTERVAL_MS },
  },
  // L5-P1 (E2 ignition) — the pre-start orchestrator sweep. Every 60s: reconcile
  // pending materialization intents + intake-materialize on placement.process.created
  // (placements with no intent yet) + cancel unresolved requirements on placement
  // terminal (NO_SHOW / FELL_THROUGH). Idempotency rides E2's own state (intent unique
  // + instance resolution) — no new inbox. Silent without Redis (CI / local dev); the
  // tick seam is proven directly via PreStartOrchestratorService. The 17th repeat queue
  // (offer-expiry is the 16th).
  {
    queue_name: PRE_START_ORCHESTRATOR_QUEUE_NAME,
    job_name: 'tick',
    job_id: 'pre-start-orchestration-60s',
    repeat: { every: PRE_START_ORCHESTRATOR_INTERVAL_MS },
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
