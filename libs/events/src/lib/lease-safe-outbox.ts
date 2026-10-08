// ADR-0033 Decision 1 — the concurrency-safe outbox claim/lease contract.
//
// A durable outbox table that multiple horizontally-scaled publishers can drain
// without double-publishing beyond at-least-once. The lease is ADVISORY, not
// exactly-once theater: a publisher that crashes after the transport accepts an
// event but before `published_at` is written will republish it later — harmless,
// because the event_id (= outbox row id) is the durable idempotency anchor and
// consumers are idempotent. ALL time decisions (lease expiry) use DB time
// (now()), never an application-node clock, so horizontally-scaled publishers
// cannot disagree about expiry.

import type { CanonicalOutboxRow } from './event-envelope.js';

// A claimed row carries its PERSISTED post-claim publish_attempts so the drain
// can decide retry-vs-quarantine deterministically from the DB value (never from
// process memory). Assignable to CanonicalOutboxRow for envelope mapping.
export interface LeasedOutboxRow extends CanonicalOutboxRow {
  readonly publish_attempts: number;
}

export interface LeaseSafeOutboxRepository {
  // Atomically claim up to `limit` CLAIMABLE rows — unpublished, not quarantined,
  // under the attempt budget, with an absent/expired lease — OLDEST-FIRST, and
  // stamp a lease expiring `lease_seconds` from DB now() (incrementing
  // publish_attempts). Uses FOR UPDATE SKIP LOCKED so concurrent publishers never
  // claim the same row. Returns the claimed rows (post-claim publish_attempts
  // included) in the canonical shape.
  claimOutboxBatch(input: {
    limit: number;
    lease_seconds: number;
    max_attempts: number;
  }): Promise<LeasedOutboxRow[]>;

  // Mark rows published (published_at = DB now()). Called ONLY with
  // transport-confirmed event ids (never the whole batch on a bare 200).
  markOutboxPublished(input: { event_ids: readonly string[] }): Promise<number>;

  // Release the lease on confirmed-FAILED rows so they are immediately
  // reclaimable next tick (records last_publish_error). Does NOT set
  // published_at. Deterministic retry: a released row re-enters the claim set.
  releaseOutboxLease(input: {
    event_ids: readonly string[];
    last_error: string;
  }): Promise<number>;

  // Park non-transient/malformed rows (exceeded the attempt budget, or could not
  // be mapped to an envelope): stops them being claimed, keeps them visible for
  // operational dead-letter handling.
  quarantineOutbox(input: {
    event_ids: readonly string[];
    reason: string;
  }): Promise<number>;
}

// Per-tick drain telemetry (ADR-0033 Decision / §18 observability).
export interface OutboxDrainOutcome {
  claimed: number;
  published: number;
  failed: number;
  quarantined: number;
}
