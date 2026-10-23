// FE mirror of the Trust Proposals worklist shape (apps/api/src/talent-identity/
// verification-proposal.controller.ts) — ATI-SEP-1 T10 WP3b: Talent Intelligence
// generates the proposals; the ATS relays them. Hand-mirrored, NOT imported.
// Dates arrive as ISO strings over JSON.

import type { IntelligenceStatus } from '../talent/dossier-api';

// OPEN is the worklist default; ACTED/DISMISSED/SETTLED are terminal browse tabs.
export type ProposalStatus = 'OPEN' | 'ACTED' | 'DISMISSED' | 'SETTLED';

// The three caseworker action kinds (R10 — kinds, never numbers).
export type ProposalKind = 'VERIFY_CONTACT' | 'RENEW_VERIFICATION' | 'RESOLVE_CONTRADICTION';

// What the human did through the real gated action (recorded on mark-acted).
export type ProposalAction = 'VERIFICATION_REQUESTED' | 'CONTRADICTION_RESOLVED' | 'RECORD_UPDATED';

// One enriched worklist row. basis_kinds are NAMED kinds (an assertion type or
// EMAIL / PHONE) — never a value or a number. record_id/slot are the act-target
// enrichment: record_id is the pointer link + deep-link target; slot is present
// only for an email VERIFY/RENEW whose slot resolved (→ one-click). The contact
// value is NEVER on the wire.
export interface ProposalListItem {
  readonly id: string;
  readonly kind: ProposalKind;
  readonly trigger_kind: string;
  readonly status: ProposalStatus;
  readonly basis_kinds: readonly string[];
  readonly assertion_id?: string;
  readonly identifier_type?: 'EMAIL' | 'PHONE';
  readonly created_at: string; // ISO
  readonly acted_at?: string;
  readonly action?: ProposalAction;
  readonly record_id?: string;
  readonly slot?: 'email1' | 'email2';
}

export interface ProposalPage {
  readonly intelligence_status: IntelligenceStatus;
  readonly items: readonly ProposalListItem[];
  readonly next_cursor: string | null;
}
