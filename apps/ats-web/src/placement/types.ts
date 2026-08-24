// Hand-mirrored from libs/placement/src/lib/lifecycle/placement-lifecycle.ts
// and libs/placement/src/lib/placement-process.types.ts (the BE sources of
// truth). R1 hand-mirrors instead of importing @aramo/placement (a forbidden
// domain edge — ADR-0029). Drift is caught by ./placement-matrix-drift.spec.ts,
// which reads the BE source as text and asserts the state/position/transition
// sets match.

export const PLACEMENT_STATE_VALUES = [
  'OFFER_EXTENDED',
  'OFFER_ACCEPTED',
  'PRE_START',
  'BLOCKED',
  'READY_TO_START',
  'STARTED',
  'OFFER_DECLINED',
  'OFFER_RESCINDED',
  'NO_SHOW',
  'FELL_THROUGH',
] as const;
export type PlacementState = (typeof PLACEMENT_STATE_VALUES)[number];

export type LifecyclePosition = 'PRE_COMMITMENT' | 'COMMITTED' | 'ENGAGED' | 'TERMINAL';

export const STATE_POSITION: Record<PlacementState, LifecyclePosition> = {
  OFFER_EXTENDED: 'PRE_COMMITMENT',
  OFFER_ACCEPTED: 'COMMITTED',
  PRE_START: 'COMMITTED',
  BLOCKED: 'COMMITTED',
  READY_TO_START: 'COMMITTED',
  STARTED: 'ENGAGED',
  OFFER_DECLINED: 'TERMINAL',
  OFFER_RESCINDED: 'TERMINAL',
  NO_SHOW: 'TERMINAL',
  FELL_THROUGH: 'TERMINAL',
};

// The 14 legal edges (BE §4). Terminal/engaged states declare [].
export const TRANSITIONS: Record<PlacementState, readonly PlacementState[]> = {
  OFFER_EXTENDED: ['OFFER_ACCEPTED', 'OFFER_DECLINED', 'OFFER_RESCINDED'],
  OFFER_ACCEPTED: ['PRE_START', 'OFFER_RESCINDED', 'FELL_THROUGH'],
  PRE_START: ['READY_TO_START', 'BLOCKED', 'FELL_THROUGH'],
  BLOCKED: ['PRE_START', 'FELL_THROUGH'],
  READY_TO_START: ['STARTED', 'NO_SHOW', 'FELL_THROUGH'],
  STARTED: [],
  OFFER_DECLINED: [],
  OFFER_RESCINDED: [],
  NO_SHOW: [],
  FELL_THROUGH: [],
};

// Recruiter-facing labels for the placement lifecycle state.
export const PLACEMENT_STATE_LABELS: Record<PlacementState, string> = {
  OFFER_EXTENDED: 'Offer extended',
  OFFER_ACCEPTED: 'Offer accepted',
  PRE_START: 'Pre-start',
  BLOCKED: 'Blocked',
  READY_TO_START: 'Ready to start',
  STARTED: 'Started',
  OFFER_DECLINED: 'Offer declined',
  OFFER_RESCINDED: 'Offer rescinded',
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
