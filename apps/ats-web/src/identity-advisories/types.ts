// FE mirror of the identity-advisory worklist shape (apps/api/src/talent-identity/
// advisory-resolution.controller.ts). Hand-mirrored, NOT imported: ats-web is
// untagged and must not import the api app. Typed to what the wire delivers —
// Dates arrive as ISO strings over JSON.
//
// ATI-SEP-1 T10 WP2 — the advisory is the ATS-local within-tenant duplicate
// advisory: two talent records (basis EMAIL | PHONE) or a sourced arrival and a
// talent record (basis SOURCED_ARRIVAL) sharing a normalized email / cell phone.
// The trust-only fields (advise band, contradiction flags, confirmed /
// contradiction / conflict kinds, reopen provenance) are gone.

// The advisory review lifecycle. PENDING_REVIEW is the worklist default; the
// other three are the terminal/reversed states a reviewer can browse read-only.
export type AdvisoryStatus = 'PENDING_REVIEW' | 'APPROVED' | 'DISMISSED' | 'REVERSED';

export interface AdvisoryListItem {
  readonly id: string;
  readonly tenant_id: string;
  readonly talent_record_a_id: string;
  readonly talent_record_a_name: string | null;
  readonly talent_record_b_id: string | null;
  readonly talent_record_b_name: string | null;
  readonly sourced_talent_id: string | null;
  readonly sourced_talent_name: string | null;
  readonly basis: string;
  readonly status: AdvisoryStatus;
  readonly created_at: string; // ISO
  // NAMED shared kinds (e.g. 'EMAIL', 'PHONE') — never a value.
  readonly shared_anchor_kinds: readonly string[];
}

export interface AdvisoryPage {
  readonly items: readonly AdvisoryListItem[];
  // Opaque keyset cursor for the next page, or null on the last page.
  readonly next_cursor: string | null;
}
