// Track 7 / T7-P5 — FE mirror of the PermanentPlacement read contract. Hand-mirrored from
// libs/placement/src/lib/placement-process.types.ts + lifecycle/placement-lifecycle.ts (the BE
// sources of truth). R1/ADR-0029: ats-web NEVER imports @aramo/placement (a forbidden domain
// edge); drift is caught by ./permanent-placement-drift.spec.ts, which reads the BE source as
// text and asserts the state/policy sets match. Dates that are @db.Date on the BE (guarantee
// window, falloff effective date) arrive as ISO strings and must be rendered with the
// timezone-safe `formatDate`; TIMESTAMPTZ instants (created/recorded/completed/due) use
// `formatInstant`.

export const PERMANENT_PLACEMENT_STATE_VALUES = [
  'GUARANTEE_ACTIVE',
  'GUARANTEE_SATISFIED',
  'FELL_OFF',
  'REPLACEMENT_DUE',
  'REFUND_DUE',
  'PRORATED_CREDIT_DUE',
  'REMEDY_COMPLETED',
] as const;
export type PermanentPlacementState = (typeof PERMANENT_PLACEMENT_STATE_VALUES)[number];

// Recruiter-facing labels (explicit text — state is never communicated by color alone, §11).
export const PERMANENT_PLACEMENT_STATE_LABELS: Record<PermanentPlacementState, string> = {
  GUARANTEE_ACTIVE: 'Guarantee active',
  GUARANTEE_SATISFIED: 'Guarantee satisfied',
  FELL_OFF: 'Fell off',
  REPLACEMENT_DUE: 'Replacement due',
  REFUND_DUE: 'Refund due',
  PRORATED_CREDIT_DUE: 'Prorated credit due',
  REMEDY_COMPLETED: 'Remedy completed',
};

// The five states that descend from a qualifying falloff (the "fell-off family").
export const FELL_OFF_FAMILY: readonly PermanentPlacementState[] = [
  'FELL_OFF',
  'REPLACEMENT_DUE',
  'REFUND_DUE',
  'PRORATED_CREDIT_DUE',
  'REMEDY_COMPLETED',
];
// The three outstanding-obligation states.
export const REMEDY_DUE_STATES: readonly PermanentPlacementState[] = [
  'REPLACEMENT_DUE',
  'REFUND_DUE',
  'PRORATED_CREDIT_DUE',
];

export const REMEDY_POLICY_VALUES = ['REPLACEMENT', 'REFUND', 'PRORATED_CREDIT'] as const;
export type RemedyPolicy = (typeof REMEDY_POLICY_VALUES)[number];

export const REMEDY_POLICY_LABELS: Record<RemedyPolicy, string> = {
  REPLACEMENT: 'Replacement',
  REFUND: 'Refund',
  PRORATED_CREDIT: 'Prorated credit',
};

// The remedy obligation child (GET permanent → remedy). calculated_amount/currency are present
// only for REFUND / PRORATED_CREDIT (REPLACEMENT is non-monetary → null). These are the
// server-derived OBLIGATION facts — never caller-editable, never a payment.
export interface PermanentPlacementRemedyView {
  readonly remedy_type: RemedyPolicy;
  readonly calculated_amount: string | null;
  readonly currency: string | null;
  readonly remaining_days: number | null;
  readonly falloff_effective_date: string; // @db.Date → formatDate
  readonly due_at: string; // instant → formatInstant
  readonly completed_at: string | null; // instant
  readonly completed_by: string | null;
  readonly completion_reference: string | null;
  readonly replacement_placement_process_id: string | null;
}

// The immutable per-placement activation snapshot (GET /v1/placements/:id/permanent).
// Deliberately carries NO P3 term-version provenance (guarantee_term_version_id etc.) — the
// snapshot is the source of truth; term-version provenance lives only on the terms surface.
export interface PermanentPlacementView {
  readonly id: string;
  readonly tenant_id: string;
  readonly placement_process_id: string;
  readonly submittal_id: string;
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly lifecycle_state: PermanentPlacementState;
  readonly guarantee_start_date: string; // @db.Date → formatDate
  readonly guarantee_duration_days: number;
  readonly guarantee_end_date: string; // @db.Date → formatDate
  readonly remedy_policy: RemedyPolicy;
  readonly guarantee_exposure_amount: string; // decimal string
  readonly guarantee_exposure_currency: string;
  readonly terms_source: string;
  readonly recorded_by: string;
  readonly created_at: string; // instant → formatInstant
  readonly falloff_effective_date: string | null; // @db.Date
  readonly falloff_reason: string | null;
  readonly falloff_recorded_by: string | null;
  readonly falloff_recorded_at: string | null; // instant
  readonly remedy: PermanentPlacementRemedyView | null;
}

// GET returns a coherent envelope; { permanent: null } means the placement has no permanent
// aggregate (a CONTRACT/legacy placement) — a real absence, never fabricated.
export interface PermanentPlacementResponse {
  readonly permanent: PermanentPlacementView | null;
}
