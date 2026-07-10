// FE mirror of the TR-12 caseworker proposal worklist shape (apps/api/src/
// talent-identity/verification-proposal.controller.ts). Hand-mirrored, NOT
// imported: ats-web is untagged and must not import the scope:cip talent-trust
// lib nor the api app (the I15 wall). Dates arrive as ISO strings over JSON.

// The proposal lifecycle. OPEN is the worklist default; ACTED/DISMISSED/SETTLED
// are terminal browse tabs.
export type ProposalStatus = 'OPEN' | 'ACTED' | 'DISMISSED' | 'SETTLED';

// The three caseworker action kinds (R10 — kinds, never numbers).
export type ProposalKind =
  | 'VERIFY_CONTACT'
  | 'RENEW_VERIFICATION'
  | 'RESOLVE_CONTRADICTION';

// One enriched worklist row. basis_kinds are NAMED kinds (anchor_kind /
// assertion_type) — never a value or a number. record_id/slot are the act-target
// enrichment: record_id is the pointer link + deep-link target; slot is present
// only for an email VERIFY/RENEW whose slot resolved (→ one-click). The anchor
// value is NEVER on the wire.
export interface ProposalListItem {
  readonly id: string;
  readonly tenant_id: string;
  readonly subject_id: string;
  readonly kind: ProposalKind;
  readonly trigger_kind: string;
  readonly basis_ref_id: string;
  readonly basis_kinds: readonly string[];
  readonly status: ProposalStatus;
  readonly created_at: string; // ISO
  readonly record_id?: string;
  readonly slot?: 'email1' | 'email2';
}

export interface ProposalPage {
  readonly items: readonly ProposalListItem[];
  readonly next_cursor: string | null;
}
