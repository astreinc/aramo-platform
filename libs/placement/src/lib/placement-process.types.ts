// Repository I/O types for the placement module (Track 3 / E1-a).
//
// These are internal function-signature types, NOT HTTP DTOs — E1-a ships no
// controller, route, or request/response DTO (that is E1-b, §7). They describe
// what the repository consumes and returns.

import type { PlacementState, PermanentPlacementState, RemedyPolicy } from './lifecycle/placement-lifecycle.js';

// Track 7 / T7-P1 — the persisted permanent-vs-contract branch fact (§3.1).
export type PlacementKind = 'CONTRACT' | 'PERMANENT';

export type CreatePlacementInput = {
  readonly tenant_id: string;
  readonly submittal_id: string;
  readonly requisition_id: string;
  readonly talent_record_id: string;
  // Offer Lifecycle (D6, R-PRECEDENCE) — the ACCEPTED offer this placement is
  // created from. REQUIRED in practice: createPlacement rejects a create whose
  // offer_id is absent or does not reference an ACCEPTED offer in this tenant
  // (the create-time referential-integrity idiom). Written once at INSERT.
  readonly offer_id?: string | null;
  // Track 7 / T7-P1 — the branch fact, persisted once at INSERT (§3.1). Optional
  // and nullable: a legacy/kind-agnostic create omits it (NULL), preserving
  // historical CONTRACT behaviour at STARTED. A flow that knows the type persists
  // it explicitly; only an explicit PERMANENT can later be started permanent.
  readonly placement_kind?: PlacementKind | null;
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
  // Track 7 / T7-P1 — the governed guarantee snapshot for the PERMANENT STARTED
  // path (§3.2 / §5). REQUIRED when the placement's persisted placement_kind is
  // PERMANENT; REJECTED (VALIDATION_ERROR) on any other target or kind — the
  // symmetric mirror of commercial_terms (which belongs to the CONTRACT path).
  // Exposure is a governed input (no ContractAssignment / AssignmentRateVersion is
  // minted on this branch, and there is NO cross-schema requisition read). The
  // recording principal is TransitionPlacementInput.recorded_by (JWT sub).
  readonly guarantee_terms?: GuaranteeTermsInput | null;
  // Track 7 / T7-P3 — the employment start (calendar date, ISO yyyy-mm-dd) for a
  // PERMANENT STARTED that relies on the reusable stored guarantee-term versions
  // (directive §3.4 / §7). The start is a per-placement fact (never a reusable term),
  // so it is supplied here when guarantee_terms is absent; the stored version effective
  // as-of this date supplies duration/remedy/exposure/currency, copied into the
  // immutable snapshot. When the legacy guarantee_terms bundle is present its own
  // guarantee_start_date is authoritative and this field is ignored.
  readonly guarantee_start_date?: string | null;
};

// Caller-supplied org snapshot for the forward STARTED -> ContractAssignment path.
export type AssignmentContext = {
  readonly company_id: string;
  readonly site_id?: string | null;
  readonly company_department_id?: string | null;
  // Slice #3 (Assignment-Extension, R-INITIAL-END) — the assignment-owned planned
  // end captured at the STARTED handoff (ISO-8601 instant). Optional in the repo
  // primitive (stored nullable — backfill-safe); REQUIRED at the HTTP business
  // operation (the controller enforces presence for a forward STARTED). The
  // requisition term MAY prefill it; once stored it is assignment-owned.
  readonly expected_end_at?: string | null;
};

// Track 7 / T7-P1 — the governed guarantee terms snapshot supplied at the PERMANENT
// STARTED handoff. guarantee_start_date is a calendar date (ISO yyyy-mm-dd) — the
// actual permanent employment start; the repository derives guarantee_end_date =
// start + duration_days (half-open window). duration_days must be a positive
// integer (else fail closed). exactly one remedy_policy. exposure_amount is a
// decimal money STRING (never float; scale-2), with its ISO-4217 currency.
// terms_source is the governed provenance label. NO hidden default, NO cross-schema
// read (§3.2 / §5).
export type GuaranteeTermsInput = {
  readonly guarantee_start_date: string;
  readonly guarantee_duration_days: number;
  readonly remedy_policy: RemedyPolicy;
  readonly exposure_amount: string;
  readonly exposure_currency: string;
  readonly terms_source: string;
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

// Slice #3 (Assignment-Extension) — v1 extend reasons (R-EXTEND-COMMAND) and the
// provenance seam (R-PROVENANCE). Hand-typed unions (decoupled from the generated
// client path). DATA_CORRECTION is intentionally absent — a future Edit/Correct
// operation, not an extension.
export type AssignmentExtensionReason =
  | 'CLIENT_REQUEST'
  | 'PROJECT_EXTENSION'
  | 'RENEWAL'
  | 'SCOPE_CONTINUATION';
export type AssignmentExtensionSource = 'MANUAL' | 'VMS' | 'API' | 'SYSTEM';

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
  // Slice #3 (Assignment-Extension) — the assignment-OWNED planned end (distinct
  // from started_at=actual-start, ended_at=actual-end). Null on a backfilled/
  // horizon-absent assignment. Extend moves it strictly forward.
  readonly expected_end_at: Date | null;
  // DERIVED (R-ENDING-SOON) — ACTIVE + expected_end_at within the horizon. Never a
  // stored state/column; computed on read via isAssignmentEndingSoon.
  readonly ending_soon: boolean;
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
  // Offer Lifecycle (D6) — the ACCEPTED offer this placement was created from
  // (NULL for legacy pre-offer rows).
  readonly offer_id: string | null;
  readonly offered_at: Date;
  readonly proposed_start_date: Date | null;
  readonly offer_expires_at: Date | null;
  readonly client_offer_reference: string | null;
  readonly offer_terms_summary: string | null;
  // Track 7 / T7-P1 — the persisted permanent-vs-contract branch fact (§3.1).
  // NULL for legacy/kind-agnostic placements (CONTRACT-compatible at STARTED).
  readonly placement_kind: PlacementKind | null;
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

// Track 7 / T7-P1 — the read view of a PermanentPlacement aggregate + its immutable
// guarantee snapshot. guarantee_exposure_amount is a scale-2 decimal string
// (money-at-boundary convention, never float). This is the shape the
// placement:permanent:read surface returns and the P1 lifecycle transition returns.
export type PermanentPlacementView = {
  readonly id: string;
  readonly tenant_id: string;
  readonly placement_process_id: string;
  readonly submittal_id: string;
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly lifecycle_state: PermanentPlacementState;
  readonly guarantee_start_date: Date;
  readonly guarantee_duration_days: number;
  readonly guarantee_end_date: Date;
  readonly remedy_policy: RemedyPolicy;
  readonly guarantee_exposure_amount: string;
  readonly guarantee_exposure_currency: string;
  readonly terms_source: string;
  readonly recorded_by: string;
  readonly created_at: Date;
  // Track 7 / T7-P2 — write-once qualifying-falloff facts (null until falloff).
  readonly falloff_effective_date: Date | null;
  readonly falloff_reason: string | null;
  readonly falloff_recorded_by: string | null;
  readonly falloff_recorded_at: Date | null;
  // Track 7 / T7-P2 — the remedy obligation (null until a falloff creates it). The
  // protected read surface (placement:permanent:read) exposes the obligation amount +
  // completion state; the outbox does NOT (§3.9).
  readonly remedy: PermanentPlacementRemedyView | null;
};

// Track 7 / T7-P2 — the remedy obligation + completion state. calculated_amount is a
// scale-2 decimal string for REFUND/PRORATED_CREDIT; null for REPLACEMENT.
export type PermanentPlacementRemedyView = {
  readonly remedy_type: RemedyPolicy;
  readonly calculated_amount: string | null;
  readonly currency: string | null;
  readonly remaining_days: number | null;
  readonly falloff_effective_date: Date;
  readonly due_at: Date;
  readonly completed_at: Date | null;
  readonly completed_by: string | null;
  readonly completion_reference: string | null;
  readonly replacement_placement_process_id: string | null;
};

// Track 7 / T7-P2 — the governed guarantee-falloff command input (§5). effective_date is
// an ISO calendar date; reason is a governed code from the closed T7 falloff registry.
// recorded_by is the acting principal (JWT sub), never the request body.
export type FalloffInput = {
  readonly tenant_id: string;
  readonly placement_process_id: string;
  readonly effective_date: string;
  readonly reason: string;
  readonly recorded_by: string;
};

// Track 7 / T7-P2 — the evidence-gated remedy-completion input (§9). Exactly one of
// replacement_placement_process_id (REPLACEMENT) or external_reference (REFUND/CREDIT);
// the repository validates coherence against the remedy type. completed_by = JWT sub.
export type RemedyCompletionInput = {
  readonly tenant_id: string;
  readonly placement_process_id: string;
  readonly replacement_placement_process_id?: string | null;
  readonly external_reference?: string | null;
  readonly completed_by: string;
};

// The permanent-placement guarantee-lifecycle transition event payload: { from, to }.
// `from` is null for the creation/activation event.
export type PermanentPlacementTransitionPayload = {
  readonly from: PermanentPlacementState | null;
  readonly to: PermanentPlacementState;
};
