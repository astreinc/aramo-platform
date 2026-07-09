// TR-5 B1 (DDR §2) — the decay-recompute sweep's queue + batch constants.
// Mirrors the TR-4 consistency / TR-6 match-sweep constants.

export const RECOMPUTE_SWEEP_QUEUE_NAME = 'trust-recompute-sweep' as const;

// Bounded per-tick batch (the gate LIMITs to this). One daily tick drains a
// slice; because the recompute advances each subject's last_recomputed_at, the
// swept subjects fall out of the gate and the backlog strictly shrinks.
export const RECOMPUTE_SWEEP_BATCH_SIZE = 100 as const;
