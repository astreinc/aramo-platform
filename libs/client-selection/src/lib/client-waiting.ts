// Canonical "waiting on the client" semantic — the ONE derivation of how long a
// submittal has been sitting with the client awaiting a decision.
//
// Owned here because the authoritative fact is a ClientSelectionProcess: the
// process is "waiting" iff it is in CLIENT_REVIEW, and the clock starts at its
// created_at (when it entered review). Age is whole CIVIL days in the app
// timezone (the shared @aramo/common primitive) — never absolute-ms division.
//
// Consumers (My Desk "awaiting client", Talent 360 attention, the Submittal
// Workspace "waiting" line) read this result; they do NOT re-decide the waiting
// state nor recompute the age. This is waiting age ONLY — there is NO SLA,
// deadline, or breach semantic here (deliberately out of scope).

import { agingDaysInTimeZone } from '@aramo/common';

import type { ClientSelectionState } from './client-selection-state.js';

// The single state that means "waiting on the client to respond". A selection in
// INTERVIEW/SELECTED/DECLINED/WITHDRAWN is not waiting-on-client.
export const CLIENT_WAITING_STATE: ClientSelectionState = 'CLIENT_REVIEW';

export function isClientWaitingState(
  state: ClientSelectionState | string | null | undefined,
): boolean {
  return state === CLIENT_WAITING_STATE;
}

// Whole civil days the client has been sitting on the selection, or null when the
// selection is NOT in the waiting state (so a consumer cannot age a non-waiting
// process). `since_ms` is ClientSelectionProcess.created_at in epoch ms.
export function deriveClientWaitingDays(args: {
  readonly selection_state: ClientSelectionState | string | null | undefined;
  readonly since_ms: number | null;
  readonly now_ms: number;
  readonly time_zone: string;
}): number | null {
  if (!isClientWaitingState(args.selection_state)) return null;
  if (args.since_ms === null || Number.isNaN(args.since_ms)) return null;
  return agingDaysInTimeZone(args.since_ms, args.now_ms, args.time_zone);
}
