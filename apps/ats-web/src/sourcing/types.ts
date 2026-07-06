// FE mirror of the B-api sourcing shapes (apps/api/src/talent-identity/
// sourcing.service.ts + advisory-resolution.controller.ts). Hand-mirrored, not
// imported: ats-web is untagged and must not import the scope:cip talent-trust
// lib nor the api app (the I15 wall). Typed to what the wire delivers — Dates
// arrive as ISO strings over JSON.

// The 4 per-dimension trust bands. Each is a PresentationBand string or null
// (null = no TrustState / no evidence yet). Rendered as BandPills (R10 — labels).
export interface TrustBands {
  readonly identity: string | null;
  readonly claims: string | null;
  readonly continuity: string | null;
  readonly eligibility: string | null;
}

// One un-promoted pool row. Lean by design (Lead ruling): the SOURCED_TALENT
// ref_id the promote POSTs need is NOT here — it is read from SubjectDetail.refs
// on drill-in, so promotion is detail-gated ("look before you promote").
export interface PoolItem {
  readonly subject_id: string;
  readonly display_name: string | null;
  readonly email: string | null;
  readonly trust_bands: TrustBands;
  readonly open_contradiction_count: number;
}

export interface PoolPage {
  readonly items: readonly PoolItem[];
  // Opaque keyset cursor for the next page, or null on the last page.
  readonly next_cursor: string | null;
}

// One evidence-ledger row. NOTE (R10): `strength` exists on the wire but is
// deliberately omitted here — it is a derived number and must never render.
export interface EvidenceRow {
  readonly id: string;
  readonly dimension: string;
  readonly assertion_type: string;
  readonly assertion_payload: unknown;
  readonly source_class: string;
  readonly method: string;
  readonly current_status: string;
  readonly collected_at: string;
  readonly created_at: string;
}

// One identity ref on the subject (SOURCED_TALENT before promotion; the promote
// POSTs read the SOURCED_TALENT ref_id from here).
export interface SubjectRefRow {
  readonly ref_type: string;
  readonly ref_id: string;
  readonly link_source: string;
}

// A pending same-human MERGE advisory surfaced on the subject detail. Resolved
// via the existing /v1/talent/identity/advisories POSTs (identity:resolve).
export interface SubjectAdvisory {
  readonly id: string;
  readonly subject_a_id: string;
  readonly subject_b_id: string;
  readonly advise_band: string;
  readonly has_contradiction: boolean;
  readonly status: string;
  readonly created_at: string;
}

export interface SubjectDetail {
  readonly subject_id: string;
  readonly display_name: string | null;
  readonly email: string | null;
  readonly trust_bands: TrustBands | null;
  readonly open_contradiction_count: number;
  readonly evidence: readonly EvidenceRow[];
  readonly refs: readonly SubjectRefRow[];
  readonly open_identity_advisories: readonly SubjectAdvisory[];
}

// The promote-outcome status union (PromotionOutcome.status). promoted /
// already_promoted are success; every deferred_* is an EXPECTED outcome that
// renders as guidance, never an error.
export type SourcingStatus =
  | 'promoted'
  | 'already_promoted'
  | 'deferred_unresolved_identity'
  | 'deferred_no_name'
  | 'deferred_no_basis'
  | 'deferred_unknown_subject';

export interface SourcingResult {
  readonly status: SourcingStatus;
  readonly talent_record_id?: string;
  readonly pipeline_id?: string | null;
  readonly bench_id?: string;
}

// The ref_type vocabulary the trigger POSTs accept (mirrors the api DTO). The
// promote reads the SOURCED_TALENT ref off the detail.
export type SourcingRefType = 'SOURCED_TALENT' | 'PERSON_CLUSTER' | 'ATS_TALENT_RECORD';

// The advisory as returned by the resolution POSTs (AdvisoryView). Only the
// fields the drawer needs after a resolve are typed; the surface reads status.
export interface AdvisoryView {
  readonly id: string;
  readonly status: string;
  readonly has_contradiction: boolean;
  readonly resolution_action: string | null;
}
