// Requisition Talent Board — projection DTOs (TB-1).
//
// A read-only projection of Talent-on-a-Requisition assembled from authoritative
// owners (Pipeline · Submittal · ClientSelection · Offer · Placement/Pre-Start ·
// submittal-eligibility). State enums + readiness facts only — no REQUISITION
// commercial/bill/margin financial is ever composed here (those ride their own
// scoped read boundary, TB-later). TB-chips REFINEMENT (PO-authorized, Lead to
// ratify): the TALENT's desired_pay — a talent:read attribute already surfaced on
// the enrichment read (PipelineView.desired_rate) — IS carried as a card chip; it
// is not a requisition commercial figure. The Board is NEVER a source of truth (§1).

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
  // Per-card recruiting-fact blockers already available on main (resume selected,
  // RTR executed). The FULL per-talent policy gate is re-grounded at TB-4.
  readonly blockers: readonly string[];
  readonly band: QualifiedBand | null; // set only for cards in the `qualified` column
}

// The requisition-specific resume (§13) — the working selection pre-submit, the
// frozen submitted edition post-submit. Never the Talent's latest resume.
export interface BoardResume {
  readonly resume_edition_id: string | null;
  readonly source: 'working_selection' | 'submitted_frozen' | 'none';
  readonly locked: boolean; // true once submitted (frozen evidence)
  // Prototype-fidelity — the edition's human LABEL + its DATE (created_at as an
  // ISO string), projected from talent-evidence via the RESUME_EDITION_READER port
  // (the Board is never the source of truth). Null when no edition is linked
  // (source:'none') or the edition metadata could not be resolved.
  readonly label: string | null;
  readonly display_date: string | null;
  // DERIVED tailored-for-this-requisition marker: true iff the edition was tailored
  // FOR this requisition (the AUTHORITATIVE edition.requisition_id === the board's
  // requisition_id) — never inferred from filename/UI text. False for a general
  // edition, an edition tailored for a different requisition, or no edition.
  readonly tailored_for_requisition: boolean;
}

// A single BOUNDED next action (TB-3) — the ONE governed command the card's deepest owner
// exposes for its current state. NOT a generic action-availability engine (§ prohibitions):
// there is no `GET /available-actions`, no capability matrix; each entry is an owner-owned
// command route the Board already knows, gated by the owner state, mirroring
// `talent-journey-read.deriveActions`. `required_scope` lets the UI hide an action the actor
// cannot perform — the SERVER stays authoritative (UI hiding is never the boundary, §16).
export interface BoardNextAction {
  readonly key: string; // stable action key (e.g. 'pipeline.mark_qualified', 'offer.create')
  readonly label: string;
  readonly owner: BoardOwner;
  readonly command_route: string; // an EXISTING governed command route (never a Board route)
  readonly required_scope: string;
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
  // TB-chips — the recruiting-stage readiness fact chips. ADDED alongside the binary rtr_state
  // (which the List view still reads — ADD-not-rename). rtr_status is the 3-state signing chip
  // (null = RTR not required for the requisition → render nothing); email/voice_evidence are the
  // grounded per-channel engagement facts (provider-verified send / two-way call). desired_pay is
  // the TALENT's desired rate — a talent:read ATTRIBUTE already surfaced on the enrichment read
  // (PipelineView.desired_rate), NOT a requisition commercial/bill/margin figure (those remain
  // excluded; null here when the actor lacks talent:read or the talent has no desired pay).
  readonly rtr_status: 'NOT_SENT' | 'SENT' | 'CONFIRMED' | null;
  readonly email_evidence: boolean;
  readonly voice_evidence: boolean;
  readonly desired_pay: string | null;
  readonly readiness: BoardReadiness | null; // present on recruiting-lane cards
  // Days in the CURRENT stage, derived from the latest transition timestamp (§22).
  readonly days_in_stage: number | null;
  readonly stage_entered_at: string | null; // ISO; the authoritative transition timestamp
  readonly assigned_recruiter_user_id: string | null; // requisition-grain RequisitionAssignment (§14)
  // TB-3 — the bounded governed next action(s) for this card's current state (may be empty).
  readonly next_actions: readonly BoardNextAction[];
  // TB-6 — DERIVED downstream-handoff marker: true once the card has crossed the §3.2 handoff
  // boundary (Offer onward). The Board TRACKS these lifecycles read-only — it never owns them;
  // a handoff card is not governed-draggable and its commands live in the owning surface.
  readonly handoff: boolean;
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
