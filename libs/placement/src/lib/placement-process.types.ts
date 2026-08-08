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
  // Initial offer snapshot (E1-c 9-c-1). offered_at defaults to the server time
  // of the offer fact when omitted; the rest are nullable operational fields.
  readonly offered_at?: Date;
  readonly proposed_start_date?: Date | null;
  readonly offer_expires_at?: Date | null;
  readonly client_offer_reference?: string | null;
  readonly offer_terms_summary?: string | null;
  // E4 — replacement lineage. When present, this attempt replaces a terminal
  // predecessor; the repository validates existence, tenant, requisition and
  // pre-start-terminal eligibility (§5) and persists the pointer once at INSERT.
  // Authorization for a replacement (placement:create AND placement:replace) is
  // a conjunction enforced at the controller (§3).
  readonly replaces_placement_process_id?: string | null;
};

export type TransitionPlacementInput = {
  readonly tenant_id: string;
  readonly placement_process_id: string;
  readonly to: PlacementState;
  // E3 — governed terminal/fallthrough reason evidence. reason_code is required
  // (validated) for a transition into a governed terminal state and must be
  // absent for a non-governed edge; reason_detail is governed by the code's
  // detail policy. Both snake_case (repository serialization convention).
  readonly reason_code?: string | null;
  readonly reason_detail?: string | null;
  // Track 4 / T4-A1 — org/site snapshot for the forward STARTED ->
  // ContractAssignment path. Supplied by the orchestrating caller (which holds
  // requisition access), so libs/placement stays zero-outgoing-edge with no
  // cross-schema read (§4: declare the dependency, never conceal it in raw SQL).
  // Required on a transition to STARTED (company_id is snapshot-stored on the
  // forward assignment); ignored for every other target.
  readonly assignment_context?: AssignmentContext | null;
};

// Caller-supplied org snapshot for the forward STARTED -> ContractAssignment path.
export type AssignmentContext = {
  readonly company_id: string;
  readonly site_id?: string | null;
  readonly company_department_id?: string | null;
};

// Track 4 / T4-C — the ratified ending-reason taxonomy (closed set). COMPLETED =
// normal completion; WORKER_ENDED = worker quit/resigned; CLIENT_ENDED =
// employer/client ended. Distinguishes the three business categories structurally.
export type ContractAssignmentEndReason = 'COMPLETED' | 'WORKER_ENDED' | 'CLIENT_ENDED';

export type PlacementProcessView = {
  readonly id: string;
  readonly tenant_id: string;
  readonly submittal_id: string;
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly state: PlacementState;
  readonly offered_at: Date;
  readonly proposed_start_date: Date | null;
  readonly offer_expires_at: Date | null;
  readonly client_offer_reference: string | null;
  readonly offer_terms_summary: string | null;
  readonly created_at: Date;
};

export type PlacementProcessEventView = {
  readonly id: string;
  readonly tenant_id: string;
  readonly placement_process_id: string;
  readonly event_type: 'state_transition';
  readonly event_payload: unknown;
  // E3 — reason evidence. Null for non-governed transitions and legacy pre-E3
  // events (a null here is legacy/non-governed absence, NEVER a canonical reason).
  // reason_detail is tenant-owned PII-bearing free text; a read surface must gate
  // its exposure to roles already permitted to see placement evidence (E1-d).
  readonly reason_code: string | null;
  readonly reason_label_snapshot: string | null;
  readonly reason_detail: string | null;
  readonly created_at: Date;
};

// The state_transition event payload shape: { from, to }.
export type StateTransitionPayload = {
  readonly from: PlacementState;
  readonly to: PlacementState;
};
