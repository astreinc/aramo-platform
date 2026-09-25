// Requisition Talent Board — projection DTOs (TB-1).
//
// A read-only projection of Talent-on-a-Requisition assembled from authoritative
// owners (Pipeline · Submittal · ClientSelection · Offer · Placement/Pre-Start ·
// submittal-eligibility). STATE ENUMS ONLY — no compensation/bill field is ever
// composed here (financials ride their own scoped read boundary, TB-later). The
// Board owns presentation; it is NEVER a source of truth (directive §1).

// The Board's OWN display-column vocabulary (not an owner ontology). Each column
// maps to an authoritative domain + persisted state(s) — see TB-0-projection-contract.md.
export type BoardColumnKey =
  | 'pipeline'
  | 'contacted'
  | 'qualified'
  | 'submitted'
  | 'interview'
  | 'selected'
  | 'offer'
  | 'accepted'
  | 'prestart'
  | 'ready'
  | 'started';

// The lifecycle owner a card's CURRENT column is derived from (attribution — a
// column is never emitted without a backing owner row).
export type BoardOwner = 'pipeline' | 'submittal' | 'client_selection' | 'offer' | 'placement';

// The Qualified column's two derived readiness bands (§6) — derived, NOT a
// Pipeline status. `ready_to_submit` reflects authoritative submittal readiness.
export type QualifiedBand = 'ready_to_submit' | 'needs_action';

// The requisition-grain submittal readiness (§7/§10) — consumed from the
// authoritative RequisitionSubmittalEligibilityReader; the Board never computes it.
export interface BoardReadiness {
  readonly requisition_state: 'open' | 'paused' | 'closed';
  readonly requisition_reason: string | null; // deadline_passed | limit_reached | manual_hold | paused
  // Per-card recruiting-fact blockers already available on main (résumé selected,
  // RTR executed). The FULL per-talent policy gate is re-grounded at TB-4.
  readonly blockers: readonly string[];
  readonly band: QualifiedBand | null; // set only for cards in the `qualified` column
}

// The requisition-specific résumé (§13) — the working selection pre-submit, the
// frozen submitted edition post-submit. Never the Talent's latest résumé.
export interface BoardResume {
  readonly resume_edition_id: string | null;
  readonly source: 'working_selection' | 'submitted_frozen' | 'none';
  readonly locked: boolean; // true once submitted (frozen evidence)
}

export interface BoardCardView {
  readonly talent_record_id: string;
  readonly pipeline_id: string;
  readonly column: BoardColumnKey;
  readonly owner: BoardOwner;
  // The authoritative owner-row id the column is attributed to (source_object_id).
  readonly source_object_id: string;
  // The persisted owner state enum (e.g. Pipeline `qualified`, ClientSelection `INTERVIEW`).
  readonly owner_state: string;
  readonly resume: BoardResume;
  readonly rtr_state: string | null; // recruiting-lane fact (from the readiness gate substrate)
  readonly readiness: BoardReadiness | null; // present on recruiting-lane cards
  // Days in the CURRENT stage, derived from the latest transition timestamp (§22).
  readonly days_in_stage: number | null;
  readonly stage_entered_at: string | null; // ISO; the authoritative transition timestamp
  readonly assigned_recruiter_user_id: string | null; // requisition-grain RequisitionAssignment (§14)
}

export interface BoardColumnView {
  readonly key: BoardColumnKey;
  readonly owner: BoardOwner;
  readonly count: number;
  readonly cards: readonly BoardCardView[];
}

// The collapsed Closed panel (§18) — canonical dispositions, never a Board taxonomy.
export interface BoardClosedSummary {
  readonly total: number;
  readonly by_reason: ReadonlyArray<{ reason: string; count: number }>;
}

export interface RequisitionTalentBoardView {
  readonly requisition_id: string;
  readonly columns: readonly BoardColumnView[];
  readonly closed: BoardClosedSummary;
  readonly total_active: number;
}
