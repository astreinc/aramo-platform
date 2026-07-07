// FE mirror of the TR-6 identity-advisory worklist shape (apps/api/src/
// talent-identity/advisory-list.* — the enriched keyset list of same-human
// MERGE advisories). Hand-mirrored, NOT imported: ats-web is untagged and must
// not import the scope:cip talent-trust lib nor the api app (the I15 wall).
// Typed to what the wire delivers — Dates arrive as ISO strings over JSON.

// The advisory review lifecycle. PENDING_REVIEW is the worklist default; the
// other three are the terminal/reversed states a reviewer can browse read-only.
export type AdvisoryStatus =
  | 'PENDING_REVIEW'
  | 'MERGED'
  | 'DISMISSED'
  | 'REVERSED';

// One enriched worklist row. The `*_kinds` arrays are NAMED anchor kinds (e.g.
// 'EMAIL', 'PHONE', 'NAME') the reviewer reads to judge the pair — never a
// number or a star (R10). advise_band is a PresentationBand string rendered as
// a BandPill. reopened_* is provenance: non-null when the advisory was reopened
// from an earlier resolution, carrying the band it was reopened from.
export interface AdvisoryListItem {
  readonly id: string;
  readonly tenant_id: string;
  readonly subject_a_id: string;
  readonly subject_b_id: string;
  readonly advise_band: string;
  readonly has_contradiction: boolean;
  readonly status: AdvisoryStatus;
  readonly created_at: string; // ISO
  readonly confirmed_kinds: readonly string[];
  readonly contradiction_kinds: readonly string[];
  readonly corroborator_conflict_kinds: readonly string[];
  readonly shared_anchor_kinds: readonly string[];
  readonly reopened_at: string | null;
  readonly reopened_from_band: string | null;
}

export interface AdvisoryPage {
  readonly items: readonly AdvisoryListItem[];
  // Opaque keyset cursor for the next page, or null on the last page.
  readonly next_cursor: string | null;
}
