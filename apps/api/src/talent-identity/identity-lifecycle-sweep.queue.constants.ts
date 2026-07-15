// TR-2b B2a (Directive §PR-1.3) — the daily identity-index lifecycle sweep's
// queue + engine constants. Mirrors the TR-5 recompute-sweep / TR-6 match-sweep
// constants pattern (one source of truth for BullModule.registerQueue, the
// @Processor decorator, and the getQueueToken caller in the SCHEDULES registrar).

export const IDENTITY_INDEX_LIFECYCLE_QUEUE_NAME =
  'identity-index-lifecycle' as const;

// Clusters scanned per tick — bounded (keyset by id, LIMIT) so a large index
// never holds the worker. The daily tick reaps a bounded slice; the CLI escape
// hatch keyset-loops the full estate. Matches the match-sweep batch convention.
export const IDENTITY_INDEX_LIFECYCLE_BATCH_SIZE = 100 as const;

// Duty (a), LIVE — orphan purge: a cluster failing the R4 liveness rule is only
// purged once it is older than the grace window. Engine constant, not tenant
// config (Directive §PR-1.3).
export const ORPHAN_GRACE_DAYS = 30;

// Duty (b), DARK — dormant detection: minting DormantLink rows is gated OFF. In
// B2 detection is report-only; the gated branch exists + is tested via the flag
// but is unreachable in production. Flipping this is a future P4 directive's job
// (the D14 invariant — no minting without notice capability — is thereby
// structural). NEVER set true outside a test.
export const DORMANT_LINK_MINTING_ENABLED = false;
