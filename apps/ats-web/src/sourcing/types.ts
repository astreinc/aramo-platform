// FE mirror of the sourcing shapes (apps/api/src/talent-identity/
// sourcing.service.ts + advisory-resolution.controller.ts). Hand-mirrored, not
// imported: ats-web is untagged and must not import the api app. Typed to what
// the wire delivers — Dates arrive as ISO strings over JSON.
//
// ATI-SEP-1 T10 WP2 — sourcing runs on ATS data only (sourced arrivals + ATS
// duplicate advisories). The trust fields (bands, contradiction counts, trust
// statements, evidence ledger) are gone from the wire. `subject_id` now carries
// the sourced arrival id (the drill-in key + the promote ref_id).

// One un-promoted pool row (a sourced arrival not yet linked to a talent record).
export interface PoolItem {
  readonly subject_id: string;
  readonly display_name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly source_channel: string;
  readonly arrived_at: string; // ISO
  // Pending duplicate advisories naming this arrival (review before promoting).
  readonly open_advisory_count: number;
}

export interface PoolPage {
  readonly items: readonly PoolItem[];
  // Opaque keyset cursor for the next page, or null on the last page.
  readonly next_cursor: string | null;
}

// One ref on the arrival — SOURCED_TALENT (the promote POSTs read its ref_id)
// and, when recorded, the ingestion payload it was landed from.
export interface SubjectRefRow {
  readonly ref_type: string;
  readonly ref_id: string;
  readonly link_source: string;
}

// A pending duplicate advisory on the arrival: it may be an existing talent
// record's person. Resolved via the /v1/talent/identity/advisories POSTs
// (identity:resolve).
export interface SubjectAdvisory {
  readonly id: string;
  readonly talent_record_id: string;
  readonly talent_record_name: string | null;
  readonly basis: string;
  readonly shared_kinds: readonly string[];
  readonly status: string;
  readonly created_at: string;
}

export interface SubjectDetail {
  readonly subject_id: string;
  readonly display_name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly headline: string | null;
  readonly profile_url: string | null;
  readonly source_channel: string;
  readonly arrived_at: string;
  readonly refs: readonly SubjectRefRow[];
  readonly open_identity_advisories: readonly SubjectAdvisory[];
}

// The promote-outcome status union (PromotionOutcome.status). promoted /
// already_promoted are success; every deferred_* is an EXPECTED outcome that
// renders as guidance, never an error. A tenant duplicate is a 409 (ApiError).
export type SourcingStatus =
  | 'promoted'
  | 'already_promoted'
  | 'deferred_unresolved_identity'
  | 'deferred_no_name'
  | 'deferred_no_basis'
  | 'deferred_unknown_subject'
  | 'deferred_incomplete_contact';

export interface SourcingResult {
  readonly status: SourcingStatus;
  readonly talent_record_id?: string;
  readonly pipeline_id?: string | null;
  readonly bench_id?: string;
}

// The ref_type vocabulary the trigger POSTs accept (mirrors the api DTO).
export type SourcingRefType = 'SOURCED_TALENT';

// The advisory as returned by the resolution POSTs (AdvisoryView). Only the
// fields the surfaces read after a resolve are typed.
export interface AdvisoryView {
  readonly id: string;
  readonly status: string;
  readonly basis: string;
  readonly surviving_record_id: string | null;
}
