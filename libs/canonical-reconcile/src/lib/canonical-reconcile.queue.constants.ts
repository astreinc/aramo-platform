// SKILL-TAX Canonical Reconciliation Activation — dedicated queue constants
// (one source of truth for BullModule.registerQueue, @InjectQueue, and the
// @Processor decorator). Distinct from the read-only skill-canonicalization
// resolver queue — this queue drives the reconcile WORKERS that populate
// canonical_skill_id. Payload = IDENTIFIERS ONLY (no raw skill text ever rides
// the queue; the workers re-read authoritative persisted state).

export const CANONICAL_RECONCILE_QUEUE_NAME = 'canonical-reconciliation' as const;

/** Per-entity reconcile job. */
export const CANONICAL_RECONCILE_JOB = 'reconcile' as const;

/** Repeatable backstop job (recovers post-watermark unreconciled talents). */
export const CANONICAL_RECONCILE_BACKSTOP_JOB = 'backstop' as const;

/** Backstop cadence — 300s, matching the other Aramo sweeps. Idempotent. */
export const CANONICAL_RECONCILE_BACKSTOP_INTERVAL_MS = 300_000 as const;

/** Fixed repeatable jobId so BullMQ dedups the backstop tick across restarts. */
export const CANONICAL_RECONCILE_BACKSTOP_JOB_ID = 'canonical-reconcile-backstop' as const;

/** Max talents re-driven per backstop tick (bounded — never an unbounded scan). */
export const CANONICAL_RECONCILE_BACKSTOP_BATCH = 100 as const;

// The BullMQ job payload — identifiers only, tenant-safe. `kind` discriminates
// the two reconcile workers; the worker re-reads all authoritative state.
export type CanonicalReconcileJobData =
  | { readonly kind: 'TALENT'; readonly tenant_id: string; readonly talent_id: string }
  | {
      readonly kind: 'REQUISITION';
      readonly tenant_id: string;
      readonly requisition_id: string;
      readonly golden_profile_id: string;
    };
