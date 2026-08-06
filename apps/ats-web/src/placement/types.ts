// Hand-mirrored from libs/placement/src/lib/lifecycle/placement-lifecycle.ts
// and libs/placement/src/lib/placement-process.types.ts (the BE sources of
// truth). R1 hand-mirrors instead of importing @aramo/placement (a forbidden
// domain edge — ADR-0017). Drift is caught by ./placement-matrix-drift.spec.ts,
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
