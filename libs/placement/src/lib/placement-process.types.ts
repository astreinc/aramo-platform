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
  // Track 5 / T5-P1 — the actual person-specific commercial terms materialised as
  // the INITIAL Assignment Rate Version in the SAME transaction as the FORWARD
  // STARTED ContractAssignment (Amendment A1). REQUIRED for a FORWARD transition
  // to STARTED; supplying it on any other target is rejected (VALIDATION_ERROR).
  // recorded_by is the acting principal (JWT sub) captured as the rate-version
  // recording provenance. Both are ignored for non-STARTED targets.
  readonly commercial_terms?: CommercialTermsInput | null;
  readonly recorded_by?: string | null;
};

// Caller-supplied org snapshot for the forward STARTED -> ContractAssignment path.
export type AssignmentContext = {
  readonly company_id: string;
  readonly site_id?: string | null;
  readonly company_department_id?: string | null;
};

// Track 5 / T5-P1 — the actual commercial terms of the initial Assignment Rate
// Version. Amounts are decimal strings (money-at-boundary convention, never
// float). ONE currency governs BOTH pay and bill (Amendment A1-9; mixed-currency
// is structurally impossible). currency + rate_period are validated against the
// libs/common shared closed sets at the write boundary.
export type CommercialTermsInput = {
  readonly pay_rate_amount: string;
  readonly bill_rate_amount: string;
  readonly currency: string;
  readonly rate_period: string;
};

// Track 4 / T4-C — the ratified ending-reason taxonomy (closed set). COMPLETED =
// normal completion; WORKER_ENDED = worker quit/resigned; CLIENT_ENDED =
// employer/client ended. Distinguishes the three business categories structurally.
export type ContractAssignmentEndReason = 'COMPLETED' | 'WORKER_ENDED' | 'CLIENT_ENDED';

// Track 4 / T4-D (assignment:read) — the authoritative assignment-state read view.
// ASSIGNMENT STATE ONLY: existence + lifecycle_state + end_reason + started_at +
// provenance + identity links. Deliberately NO capacity (capacity remains the
// stored openings_available authority until B2; derived capacity is A2/B2-gated
// and never exposed here) and NO org snapshot (a capacity-adjacent field).
export type ContractAssignmentView = {
  readonly id: string;
  readonly placement_process_id: string;
  readonly submittal_id: string;
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly started_at: Date;
  readonly provenance: 'FORWARD' | 'BACKFILLED';
  // Null only for a BACKFILLED assignment whose lifecycle is not known (§A3.1);
  // a FORWARD assignment always carries one.
  readonly lifecycle_state: 'ACTIVE' | 'ENDED' | null;
  // Present iff ENDED; the authoritative discriminator, never collapsed.
  readonly end_reason: ContractAssignmentEndReason | null;
};

// Track 5 / T5-P2 — the tenant-scoped, assignment:commercials:read-gated projection
// of the CURRENT effective AssignmentRateVersion of a ContractAssignment. Stored
// actuals (pay/bill/currency/period) plus the DEC-5 derived views (spread/margin/
// markup), computed-on-read via deriveCommercialMetrics — NEVER stored. Money and
// percentages are scale-2 decimal strings (money-at-boundary convention, never
// float); margin_percent/markup_percent are null on a zero denominator (§7). This
// is the T5->T9 commercial contract shape.
export type AssignmentCommercialView = {
  readonly contract_assignment_id: string;
  readonly assignment_rate_version_id: string;
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly pay_rate_amount: string;
  readonly bill_rate_amount: string;
  readonly currency: string;
  readonly rate_period: string;
  readonly spread_amount: string;
  readonly margin_percent: string | null;
  readonly markup_percent: string | null;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
  readonly change_reason: string | null;
  readonly recorded_by: string;
  readonly created_at: Date;
};

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
