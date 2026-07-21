// SRC-2 PR-3 (R4) — the pure posting-transition planner. Given a publishable
// requisition's freshly-computed content hash and its existing ChannelPostingState
// (or null), it decides the action: CREATE, UPDATE, or NOOP. Expiry is a set-
// difference the orchestrator computes (a state whose requisition left the
// publishable set), gated by `shouldExpire`. This module is PURE (no I/O, no
// @aramo import) so the whole transition table is unit-testable without a DB or a
// live connector.
//
// The upsert collapse (DEV-A, ratified): Indeed exposes create AND update as ONE
// upsert mutation (`createSourcedJobPostings`), so CREATE and UPDATE both drive
// that mutation with the same (jobPostingId, sourceName). We KEEP both actions
// because they carry distinct real state — CREATE has no external_posting_id yet
// and counts against the backfill create-cap; UPDATE already has one — but the
// connector call underneath is identical.

import type { SyncStatus } from './channel-posting.types.js';

export type PostingAction = 'CREATE' | 'UPDATE' | 'NOOP';

export interface ExistingPostingState {
  content_hash: string;
  external_posting_id: string | null;
  sync_status: SyncStatus;
  tombstoned_at: Date | null;
}

// The action for a requisition that IS in the publishable set this tick.
//   no state                         → CREATE
//   state, but create never landed   → CREATE   (external_posting_id still null)
//   content changed                  → UPDATE
//   content same but not LIVE        → UPDATE   (re-drive ERROR / pending → LIVE;
//                                                the upsert is idempotent)
//   content same and LIVE            → NOOP
// This covers every SYNC_STATUSES value as an ERROR/pending re-entry: an ERROR row
// with an external id re-drives via UPDATE, one without re-drives via CREATE.
export function planPublishableAction(args: {
  contentHash: string;
  existing: ExistingPostingState | null;
}): PostingAction {
  const { contentHash, existing } = args;
  if (existing === null) return 'CREATE';
  if (existing.external_posting_id === null) return 'CREATE';
  if (existing.content_hash !== contentHash) return 'UPDATE';
  if (existing.sync_status !== 'LIVE') return 'UPDATE';
  return 'NOOP';
}

// A state whose requisition is NO LONGER publishable should be expired — unless it
// is already tombstoned/EXPIRED (jobs never age out silently; expiry is explicit
// and idempotent). A state that never went live (no external id) needs no expire
// call; the orchestrator just tombstones the local row.
export function shouldExpire(existing: {
  sync_status: SyncStatus;
  tombstoned_at: Date | null;
}): boolean {
  return existing.tombstoned_at === null && existing.sync_status !== 'EXPIRED';
}
