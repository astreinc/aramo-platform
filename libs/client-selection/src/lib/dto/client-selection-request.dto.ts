import type { ClientSelectionState } from '../client-selection-state.js';

// POST body for a ClientSelectionProcess state transition. `expected_version` is the
// optimistic-concurrency token the caller last read; a stale value is refused with
// CLIENT_SELECTION_TRANSITION_CONFLICT (409).
export interface TransitionClientSelectionRequestDto {
  readonly to_state: ClientSelectionState;
  readonly expected_version: number;
  readonly note?: string;
  // L3-E (P3) — structured decision/withdrawal cause, persisted immutably with the actor
  // so materially different DECLINED/WITHDRAWN causes are not collapsed. Optional + open.
  readonly reason_code?: string;
}

// Create is a system/orchestrator command (one process per Submittal). The apps/api
// orchestration resolves the Submittal lineage + validates existence before calling
// the repository; the HTTP body carries only the submittal id.
export interface CreateClientSelectionRequestDto {
  readonly submittal_id: string;
}
