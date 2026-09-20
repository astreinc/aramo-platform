// TALENT-INTEL-1 TI-1F-C — the NEUTRAL Talent-profile reconcile queue contract.
// This producer-only library OWNS the queue name + job contract (one source of
// truth for BullModule.registerQueue, @InjectQueue, and the worker's @Processor
// decorator). It exists to break the dependency cycle: the reconcile WORKER lives
// in libs/talent-reconcile, which already imports @aramo/talent-record; a producer
// there could not be imported by talent-record. So the queue contract + producer
// live here (a leaf that imports only @aramo/common), and BOTH talent-record
// (push signal on CONFIRM) and libs/talent-reconcile (the worker's @Processor +
// self-scheduled backstop) depend on THIS lib — never the reverse.
//
// Payload = IDENTIFIERS ONLY (tenant-safe); the worker re-reads authoritative
// EvidenceRecord + TalentRecord + field-state on every tick.

export const TALENT_RECONCILE_QUEUE_NAME = 'talent-reconcile' as const;

/** Per-subject reconcile job (the push signal + the backstop's drained work). */
export const TALENT_RECONCILE_JOB = 'reconcile' as const;

/** Repeatable backstop job — recovers subjects a missed push signal left behind. */
export const TALENT_RECONCILE_BACKSTOP_JOB = 'backstop' as const;

/** Backstop cadence — 300s, matching the other Aramo reconcile sweeps. Idempotent. */
export const TALENT_RECONCILE_BACKSTOP_INTERVAL_MS = 300_000 as const;

/** Fixed repeatable jobId so BullMQ dedups the backstop tick across restarts. */
export const TALENT_RECONCILE_BACKSTOP_JOB_ID = 'talent-reconcile-backstop' as const;

// The BullMQ job payload — identifiers only, tenant-safe. The worker re-reads all
// authoritative state; no evidence/PII ever rides the queue.
export type TalentReconcileJobData = {
  readonly kind: 'TALENT';
  readonly tenant_id: string;
  readonly talent_id: string;
};
