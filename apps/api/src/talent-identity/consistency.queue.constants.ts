// TR-4 B3 (§3.1) — the consistency detector poll's queue + batch constants.
// Mirrors the TR-6 match-sweep constants.

export const CONSISTENCY_QUEUE_NAME = 'consistency-check' as const;

// Bounded per-tick batch (the gate LIMITs to this). One tick drains a slice; the
// hourly cadence + the watermark advance mean the backlog clears across ticks.
export const CONSISTENCY_BATCH_SIZE = 100 as const;
