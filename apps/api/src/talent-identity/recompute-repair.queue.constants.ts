// G1 (Aramo-G1-TrustState-Recompute-Ordering-and-Recovery-Directive-v1_0-LOCKED
// §3.3) — the TrustState recomputation-repair job's queue + cadence + batch.
// Distinct from the daily decay sweep (trust-recompute-sweep): this one drains the
// durable per-subject requests (ResolutionSubject.trust_recompute_requested_at)
// left pending by a failed post-commit recompute.

export const RECOMPUTE_REPAIR_QUEUE_NAME = 'trust-recompute-repair' as const;

// The POLLING cadence (2 minutes). It is not a recovery SLA: failures, backlog and
// back-off can delay a repair beyond one interval.
export const RECOMPUTE_REPAIR_INTERVAL_MS = 120_000 as const;

// Bounded per-tick batch (oldest pending request first).
export const RECOMPUTE_REPAIR_BATCH_SIZE = 100 as const;
