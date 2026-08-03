// Repository I/O types for the placement module (Track 3 / E1-a).
//
// These are internal function-signature types, NOT HTTP DTOs — E1-a ships no
// controller, route, or request/response DTO (that is E1-b, §7). They describe
// what the repository consumes and returns.

import type { PlacementState } from './lifecycle/placement-lifecycle.js';

export type CreatePlacementInput = {
  readonly tenant_id: string;
  readonly submittal_id: string;
  readonly requisition_id: string;
  readonly talent_record_id: string;
};

export type TransitionPlacementInput = {
  readonly tenant_id: string;
  readonly placement_process_id: string;
  readonly to: PlacementState;
};

export type PlacementProcessView = {
  readonly id: string;
  readonly tenant_id: string;
  readonly submittal_id: string;
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly state: PlacementState;
  readonly created_at: Date;
};

export type PlacementProcessEventView = {
  readonly id: string;
  readonly tenant_id: string;
  readonly placement_process_id: string;
  readonly event_type: 'state_transition';
  readonly event_payload: unknown;
  readonly created_at: Date;
};

// The state_transition event payload shape: { from, to }.
export type StateTransitionPayload = {
  readonly from: PlacementState;
  readonly to: PlacementState;
};
