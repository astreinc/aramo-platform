// Hand-mirrored from libs/placement/src/lib/lifecycle/placement-lifecycle.ts
// and libs/placement/src/lib/placement-process.types.ts (the BE sources of
// truth). R1 hand-mirrors instead of importing @aramo/placement (a forbidden
// domain edge — ADR-0029). Drift is caught by ./placement-matrix-drift.spec.ts,
// which reads the BE source as text and asserts the state/position/transition
// sets match.

export const PLACEMENT_STATE_VALUES = [
  'PRE_START',
  'BLOCKED',
  'READY_TO_START',
  'STARTED',
  'NO_SHOW',
  'FELL_THROUGH',
] as const;
export type PlacementState = (typeof PLACEMENT_STATE_VALUES)[number];

export type LifecyclePosition = 'COMMITTED' | 'ENGAGED' | 'TERMINAL';

export const STATE_POSITION: Record<PlacementState, LifecyclePosition> = {
  PRE_START: 'COMMITTED',
  BLOCKED: 'COMMITTED',
  READY_TO_START: 'COMMITTED',
  STARTED: 'ENGAGED',
  NO_SHOW: 'TERMINAL',
  FELL_THROUGH: 'TERMINAL',
};

// The 8 legal edges (BE §4). Terminal/engaged states declare [].
export const TRANSITIONS: Record<PlacementState, readonly PlacementState[]> = {
  PRE_START: ['READY_TO_START', 'BLOCKED', 'FELL_THROUGH'],
  BLOCKED: ['PRE_START', 'FELL_THROUGH'],
  READY_TO_START: ['STARTED', 'NO_SHOW', 'FELL_THROUGH'],
  STARTED: [],
  NO_SHOW: [],
  FELL_THROUGH: [],
};

// Recruiter-facing labels for the placement lifecycle state.
export const PLACEMENT_STATE_LABELS: Record<PlacementState, string> = {
  PRE_START: 'Pre-start',
  BLOCKED: 'Blocked',
  READY_TO_START: 'Ready to start',
  STARTED: 'Started',
  NO_SHOW: 'No show',
  FELL_THROUGH: 'Fell through',
};

// The placement authority class for a transition, keyed on the TARGET state's
// lifecycle position (BE edgeAuthorityClass): TERMINAL → terminate,
// ENGAGED → activate, otherwise transition. This is the scope the guard will
// require (placement:<class>) — the board must only offer an action the
// actor's scopes permit.
export type PlacementAuthorityClass = 'transition' | 'activate' | 'terminate';

// PlacementProcessView (collection + item read). Hand-mirrored; carries NO
// reason evidence — the collection/item surfaces never expose reason fields.
export interface PlacementView {
  readonly id: string;
  readonly tenant_id: string;
  readonly submittal_id: string;
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly state: PlacementState;
  readonly offered_at: string;
  readonly proposed_start_date: string | null;
  readonly offer_expires_at: string | null;
  readonly client_offer_reference: string | null;
  readonly offer_terms_summary: string | null;
  readonly created_at: string;
}

export interface PlacementListResponse {
  readonly items: readonly PlacementView[];
}

// PlacementProcessEventView (event/reason timeline — the authorized detail
// surface). reason_* are null for legacy/non-governed events.
export interface PlacementEventView {
  readonly id: string;
  readonly tenant_id: string;
  readonly placement_process_id: string;
  readonly event_type: 'state_transition';
  readonly event_payload: { readonly from?: string; readonly to?: string } | null;
  readonly reason_code: string | null;
  readonly reason_label_snapshot: string | null;
  readonly reason_detail: string | null;
  readonly created_at: string;
}

export interface PlacementEventListResponse {
  readonly items: readonly PlacementEventView[];
}

// ── Track 4 — ContractAssignment lifecycle (assignment:read surface) ──
// Hand-mirrored from libs/placement/src/lib/placement-process.types.ts
// (ContractAssignmentView / ContractAssignmentEndReason). R1 hand-mirrors
// instead of importing @aramo/placement (a forbidden domain edge — ADR-0029).
// This is the read shape of GET /v1/placements/{id}/assignment; the response
// envelope is { assignment: ContractAssignmentView | null }. Capacity is
// DELIBERATELY ABSENT from this surface (it stays A2/B2-gated on the BE) and is
// never re-derived on the client.

export type ContractAssignmentProvenance = 'FORWARD' | 'BACKFILLED';

export type ContractAssignmentLifecycleState = 'ACTIVE' | 'ENDED';

// The authoritative ending taxonomy — never collapsed. The three reasons are a
// product-meaningful distinction and each carries its own recruiter-facing
// label; a UI must preserve the underlying discriminator.
export const ASSIGNMENT_END_REASON_VALUES = [
  'COMPLETED',
  'WORKER_ENDED',
  'CLIENT_ENDED',
] as const;
export type ContractAssignmentEndReason = (typeof ASSIGNMENT_END_REASON_VALUES)[number];

export const ASSIGNMENT_END_REASON_LABELS: Record<ContractAssignmentEndReason, string> = {
  COMPLETED: 'Completed',
  WORKER_ENDED: 'Worker ended',
  CLIENT_ENDED: 'Client ended',
};

// Track 7 / T7-PX — the FULL end-reason DISPLAY vocabulary. CONVERTED_TO_PERMANENT is a
// genuine domain end reason set ONLY by the conversion command — it is NOT a user-choosable
// End-dialog option (those stay the three above), but a converted source assignment renders
// with it, so the display map must cover it. Keyed for read-only rendering only.
export const ASSIGNMENT_END_REASON_DISPLAY_VALUES = [
  ...ASSIGNMENT_END_REASON_VALUES,
  'CONVERTED_TO_PERMANENT',
] as const;
export type ContractAssignmentEndReasonDisplay = (typeof ASSIGNMENT_END_REASON_DISPLAY_VALUES)[number];
export const ASSIGNMENT_END_REASON_DISPLAY_LABELS: Record<ContractAssignmentEndReasonDisplay, string> = {
  ...ASSIGNMENT_END_REASON_LABELS,
  CONVERTED_TO_PERMANENT: 'Converted to permanent',
};

export const ASSIGNMENT_LIFECYCLE_LABELS: Record<ContractAssignmentLifecycleState, string> = {
  ACTIVE: 'Active',
  ENDED: 'Ended',
};

export const ASSIGNMENT_PROVENANCE_LABELS: Record<ContractAssignmentProvenance, string> = {
  FORWARD: 'Forward',
  BACKFILLED: 'Backfilled',
};

// started_at is a Date on the BE; over JSON it arrives as an ISO string.
// lifecycle_state is null only for a BACKFILLED assignment of unknown lifecycle
// (§A3.1); end_reason is present iff ENDED.
export interface ContractAssignmentView {
  readonly id: string;
  readonly placement_process_id: string;
  readonly submittal_id: string;
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly started_at: string;
  readonly provenance: ContractAssignmentProvenance;
  readonly lifecycle_state: ContractAssignmentLifecycleState | null;
  // Display vocabulary (4) — includes the conversion end reason a converted source carries.
  readonly end_reason: ContractAssignmentEndReasonDisplay | null;
  // Slice #3 (Assignment-Extension) — the assignment-owned PLANNED end (distinct
  // from started_at=actual-start, end_reason/ENDED=actual-end). Null when unset.
  readonly expected_end_at: string | null;
  // DERIVED on the BE (never stored) — ACTIVE + expected_end_at within the horizon.
  readonly ending_soon: boolean;
}

// Slice #3 — the v1 extend reasons (mirrors the BE closed set). DATA_CORRECTION is
// deferred (a future Edit/Correct operation, not an extension).
export const ASSIGNMENT_EXTENSION_REASON_VALUES = [
  'CLIENT_REQUEST',
  'PROJECT_EXTENSION',
  'RENEWAL',
  'SCOPE_CONTINUATION',
] as const;
export type AssignmentExtensionReason =
  (typeof ASSIGNMENT_EXTENSION_REASON_VALUES)[number];
export const ASSIGNMENT_EXTENSION_REASON_LABELS: Record<
  AssignmentExtensionReason,
  string
> = {
  CLIENT_REQUEST: 'Client requested extension',
  PROJECT_EXTENSION: 'Project extended',
  RENEWAL: 'Renewal',
  SCOPE_CONTINUATION: 'Scope continuation',
};

// POST /v1/placements/{id}/assignment/extend body (a governed command).
export interface ExtendAssignmentRequest {
  readonly new_expected_end_at: string;
  readonly reason: AssignmentExtensionReason;
  readonly comment?: string;
}

export interface PlacementAssignmentResponse {
  readonly assignment: ContractAssignmentView | null;
}

// Track 7 / T7-PX — the Contract-to-Permanent conversion result. Hand-mirrored from the
// OpenAPI convertPlacementAssignmentToPermanent 200 shape (ADR-0029: no domain import).
// The FE navigates to target_placement_process_id — the NEW permanent PlacementProcess —
// whose PermanentPlacement panel then renders naturally via GET :id/permanent.
export interface ConvertToPermanentResponse {
  readonly replayed: boolean;
  readonly source_placement_process_id: string;
  readonly source_contract_assignment_id: string;
  readonly target_placement_process_id: string;
  readonly target_permanent_placement_id: string;
}

// Track 5 / T5-P3 — the placement-detail commercial view for commercial-authorized
// tenant roles. Hand-mirrored from the OpenAPI AssignmentCommercialView (ADR-0029: no
// domain import). Money + percentages are decimal STRINGS returned by the T5-P2
// projection (rendered verbatim — never recomputed client-side). effective_from /
// effective_to / created_at are Dates on the BE; over JSON they arrive as ISO strings.
// effective_to is null for the current (open) version. Internal identifiers are present
// in the contract but are NOT rendered by the UI (T5-P3 R9).
//
// Track 6 / T6-B4 §7/§15 — the global CompensationFieldMaskInterceptor OMITS (deletes)
// the maskable compensation fields the actor's compensation:view:* scopes do not grant
// (apps/api/src/interceptors/compensation-field-mask.interceptor.ts; scope→field map
// libs/field-masking/src/lib/compensation-field-map.ts). Omission = the KEY IS ABSENT
// from the JSON, not key-present-with-null. So pay_rate_amount / bill_rate_amount /
// margin_percent / markup_percent are OPTIONAL here: `undefined` = masked (not visible
// to this actor), distinct from `null` on a percentage (zero denominator). The UI MUST
// render an omitted value with a non-leaking indicator and never as `undefined`. currency,
// rate_period and spread_amount are not in the mask map, so they are never omitted.
export interface AssignmentCommercialView {
  readonly contract_assignment_id: string;
  readonly assignment_rate_version_id: string;
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly pay_rate_amount?: string;
  readonly bill_rate_amount?: string;
  readonly currency: string;
  readonly rate_period: string;
  readonly spread_amount: string;
  readonly margin_percent?: string | null;
  readonly markup_percent?: string | null;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly change_reason: string | null;
  readonly recorded_by: string;
  readonly created_at: string;
}

export interface AssignmentCommercialResponse {
  readonly commercials: AssignmentCommercialView | null;
}

// Track 6 / T6-B4 §15 — the commercial revision SERIES (GET .../revisions): non-cancelled
// versions (historical + current + future) effective_from DESC. The B2 envelope is
// { items }. Each item rides the same compensation mask as the singular view above.
export interface AssignmentCommercialSeriesResponse {
  readonly items: readonly AssignmentCommercialView[];
}

// Track 6 / T6-B4 §7 amendment — the create-revision request for B4 v1. Effective-now
// ONLY: effective_from is DELIBERATELY ABSENT from this type so the client can never
// send it and the server supplies the authoritative instant (Amendment §4/§7). pay/bill
// are decimal money strings; currency/rate_period are the closed sets re-validated at
// the BE write boundary; change_reason is required. tenant / assignment / version ids,
// lineage, recorded_by and effective_to are server-derived / forbidden on the wire.
export interface CommercialRevisionCreateRequest {
  readonly pay_rate_amount: string;
  readonly bill_rate_amount: string;
  readonly currency: string;
  readonly rate_period: string;
  readonly change_reason: string;
}

// The create response — the new CURRENT version (never null on success), B2 shape
// { commercials }. Rides the compensation mask like every commercial view.
export interface AssignmentCommercialCreatedResponse {
  readonly commercials: AssignmentCommercialView;
}

// Track 6 / T6-B4 §12 — the CLOSED user-selectable cancellation-reason vocabulary.
// Hand-mirrored (ADR-0029: no @aramo/placement import) from
// libs/placement/src/lib/reasons/commercial-cancellation-reasons.ts (USER_CANCELLATION_
// REASON_CODES). The reserved internal ASSIGNMENT_ENDED is DELIBERATELY EXCLUDED — the
// explicit cancellation UI must never offer or send it (directive §12; BE rejects it).
export const COMMERCIAL_CANCELLATION_REASON_VALUES = [
  'SCHEDULE_WITHDRAWN',
  'CLIENT_REQUEST',
  'WORKER_REQUEST',
  'DATA_CORRECTION',
] as const;
export type CommercialCancellationReasonCode =
  (typeof COMMERCIAL_CANCELLATION_REASON_VALUES)[number];

// Recruiter-facing labels for the cancellation reasons.
export const COMMERCIAL_CANCELLATION_REASON_LABELS: Record<
  CommercialCancellationReasonCode,
  string
> = {
  SCHEDULE_WITHDRAWN: 'Schedule withdrawn',
  CLIENT_REQUEST: 'Client request',
  WORKER_REQUEST: 'Worker request',
  DATA_CORRECTION: 'Data correction',
};

// The cancellation request body — the only wire field is the user-selectable reason.
export interface CommercialRevisionCancelRequest {
  readonly cancellation_reason_code: CommercialCancellationReasonCode;
}

// ── Slice #4 — Commercial Approval (CommercialRevisionProposal) ──
// Hand-mirrored from the BE CommercialProposalView contract (ADR-0029: no @aramo/placement
// import). A proposal is INTENT, an approval is AUTHORITY, an AssignmentRateVersion is
// APPLIED TRUTH. The proposal advances through a review → client-approval → apply lifecycle;
// the client renders server state verbatim and never re-derives the state or the margin.

export const COMMERCIAL_PROPOSAL_STATE_VALUES = [
  'DRAFT',
  'PENDING_REVIEW',
  'PENDING_CLIENT_APPROVAL',
  'APPROVED',
  'APPLIED',
  'REJECTED',
  'WITHDRAWN',
] as const;
export type CommercialProposalState = (typeof COMMERCIAL_PROPOSAL_STATE_VALUES)[number];

export const COMMERCIAL_PROPOSAL_STATE_LABELS: Record<CommercialProposalState, string> = {
  DRAFT: 'Draft',
  PENDING_REVIEW: 'Pending margin review',
  PENDING_CLIENT_APPROVAL: 'Pending client approval',
  APPROVED: 'Approved',
  APPLIED: 'Applied',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};

// The terminal states carry no governed affordance (read-only from here).
export const COMMERCIAL_PROPOSAL_TERMINAL_STATES: readonly CommercialProposalState[] = [
  'APPLIED',
  'REJECTED',
  'WITHDRAWN',
];

// The evidentiary source for a recorded client approval (closed set, mirrors the BE).
export const CLIENT_APPROVAL_SOURCE_VALUES = [
  'MANUAL',
  'EMAIL',
  'VMS',
  'CLIENT_PORTAL',
  'API',
] as const;
export type ClientApprovalSource = (typeof CLIENT_APPROVAL_SOURCE_VALUES)[number];

export const CLIENT_APPROVAL_SOURCE_LABELS: Record<ClientApprovalSource, string> = {
  MANUAL: 'Manual',
  EMAIL: 'Email',
  VMS: 'VMS',
  CLIENT_PORTAL: 'Client portal',
  API: 'API',
};

// One side (current or proposed) of the margin comparison. Money/percent are decimal
// STRINGS the BE derives verbatim (never recomputed on the client); margin/markup percent
// are null on a zero denominator.
export interface CommercialMarginSide {
  readonly pay_rate_amount: string;
  readonly bill_rate_amount: string;
  readonly currency: string;
  readonly rate_period: string;
  readonly spread_amount: string;
  readonly margin_percent: string | null;
  readonly markup_percent: string | null;
}

// The BE-derived current → proposed → delta comparison carried on every proposal view.
export interface CommercialMarginComparison {
  readonly current: CommercialMarginSide;
  readonly proposed: CommercialMarginSide;
  readonly pay_rate_delta: string;
  readonly bill_rate_delta: string;
  readonly margin_point_delta: string | null;
}

// The full CommercialProposalView. Nullable evidentiary fields are populated as the
// proposal advances (review → client approval → apply / reject). requested_by is the
// proposer's user id — the client compares it to session.sub for segregation-of-duties.
export interface CommercialProposalView {
  readonly id: string;
  readonly contract_assignment_id: string;
  readonly placement_process_id: string;
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly state: CommercialProposalState;
  readonly proposed_pay_rate_amount: string;
  readonly proposed_bill_rate_amount: string;
  readonly proposed_currency: string;
  readonly proposed_rate_period: string;
  readonly proposed_effective_from: string | null;
  readonly reason: string;
  readonly requested_by: string;
  readonly margin: CommercialMarginComparison;
  readonly review_decided_by: string | null;
  readonly review_decided_at: string | null;
  readonly review_note: string | null;
  readonly client_approved_at: string | null;
  readonly client_approval_recorded_by: string | null;
  readonly client_reference: string | null;
  readonly client_approval_source: string | null;
  readonly client_approval_note: string | null;
  readonly rejected_by: string | null;
  readonly rejected_at: string | null;
  readonly rejection_reason: string | null;
  readonly applied_rate_version_id: string | null;
  readonly applied_by: string | null;
  readonly applied_at: string | null;
  readonly created_at: string;
}

// Response envelopes (mirror the BE): detail is nullable (a real absence), list is { items },
// propose/transition/decision each return { proposal } (never null on success).
export interface CommercialProposalResponse {
  readonly proposal: CommercialProposalView | null;
}
export interface CommercialProposalListResponse {
  readonly items: readonly CommercialProposalView[];
}
export interface CommercialProposalMutationResponse {
  readonly proposal: CommercialProposalView;
}

// POST .../proposals body — propose a commercial revision. effective_from is OPTIONAL
// (the server supplies the authoritative instant when absent); reason is required.
export interface ProposeCommercialRevisionRequest {
  readonly pay_rate_amount: string;
  readonly bill_rate_amount: string;
  readonly currency: string;
  readonly rate_period: string;
  readonly effective_from?: string;
  readonly reason: string;
}

// PATCH .../proposals/{id} body — the PROPOSER transition (submit for review / withdraw).
export type CommercialProposalTransitionAction = 'submit' | 'withdraw';
export interface CommercialProposalTransitionRequest {
  readonly action: CommercialProposalTransitionAction;
}

// POST .../proposals/{id}/decision body — the AUTHORITY decision. margin_approve advances
// review; client_approve records the client's approval (with evidence); apply materialises
// the rate version; reject terminates. Segregation of duties (actor ≠ proposer) is enforced
// on the BE and mirrored in the UI (the affordance is HIDDEN for the proposer).
export type CommercialProposalDecisionAction =
  | 'margin_approve'
  | 'client_approve'
  | 'apply'
  | 'reject';
export interface CommercialProposalDecisionRequest {
  readonly action: CommercialProposalDecisionAction;
  readonly note?: string;
  readonly client_reference?: string;
  readonly client_approval_source?: ClientApprovalSource;
}
