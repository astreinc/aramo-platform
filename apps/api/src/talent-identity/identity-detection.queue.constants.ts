// TR-6 B1 (DDR §7) — recurring integrity-detection queue constants. Mirrors the
// poll queue-constants pattern (one source of truth for BullModule.registerQueue,
// the @Processor decorator, and the SCHEDULES registrar's getQueueToken).
//
// A DAILY cron runs the cheap detector classes Q4 enumerated. Propose/dispose:
// the detectors REPORT (structured logs + per-class counts) and humans act — no
// dashboard, no auto-remediation, READ-ONLY (mutates nothing).
export const IDENTITY_DETECTION_QUEUE_NAME = 'identity-detection' as const;

// Age thresholds (engine constants, not tenant config). A PENDING operation is a
// crash-orphaned reconcile if it has not completed in a day (reconciles complete
// in seconds); a PENDING_REVIEW advisory beyond a week is a reviewer-backlog signal.
export const STALE_PENDING_OPERATION_AGE_MS = 24 * 60 * 60 * 1000;
export const STALE_PENDING_ADVISORY_AGE_MS = 7 * 24 * 60 * 60 * 1000;
