// SRC-2 PR-2 — distribution types.
//
// The R3 discipline made structural: ChannelPostingInput is an EXPLICIT allowlist.
// It lists ONLY publishable fields; it is structurally incapable of expressing any
// of the field-masking compensation map's 13 keys or the financials map's 7 keys.
// A type-level negative spec (@ts-expect-error per gated key) and a runtime spec
// (fixture carrying every gated key → builder output contains none) enforce this.

// ChannelPostingState.sync_status — closed union stored as TEXT (convention R7).
// Shaped against R4's transitions: create → PENDING_CREATE → LIVE; content change
// → PENDING_UPDATE → LIVE; expire (status leaves active / public_listing cleared /
// row deleted) → PENDING_EXPIRE → EXPIRED; connector failure → ERROR.
export const SYNC_STATUSES = [
  'PENDING_CREATE',
  'LIVE',
  'PENDING_UPDATE',
  'PENDING_EXPIRE',
  'EXPIRED',
  'ERROR',
] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

// The allowlist input to the payload builder. EVERY field here is a publishable,
// UN-gated fact. There is deliberately NO field named for any gated compensation
// actual (pay_rate_*, bill_rate_*, placement_fee_*, salary_*, margin_*, markup_*)
// or financial-planning key (target_margin_percent, markup_percent_target,
// rate_card_id, min/max_bill_rate, min/max_pay_rate). Advertised comp is the
// recruiter's authored public statement, distinct from the gated actuals.
export interface ChannelPostingInput {
  // Opaque cross-schema reference to the requisition (UUID) + tenant.
  requisition_id: string;
  tenant_id: string;

  // Role content (all UN-gated).
  title: string;
  description: string | null;
  city: string | null;
  state_code: string | null;
  // Hardcoded/config at the call site (e.g. 'US') — not a stored gated field.
  country: string;
  job_type: string | null;
  work_arrangement: string | null;
  openings: number;

  // Advertised comp — the authored public statement (NOT the gated actuals).
  advertised_pay_min: string | null;
  advertised_pay_max: string | null;
  advertised_pay_period: string | null;
  advertised_pay_currency: string | null;

  // Publication intent + posting timestamps.
  public_listing: boolean;
  posted_at: string;
  updated_at: string;
}

// The channel-agnostic posting payload the builder emits. The connector (PR-3)
// maps this to a specific channel's schema; the content hash is taken over its
// canonical serialization.
export interface ChannelPostingPayload {
  external_requisition_ref: string;
  title: string;
  description: string | null;
  location: {
    city: string | null;
    state_code: string | null;
    country: string;
  };
  job_type: string | null;
  work_arrangement: string | null;
  openings: number;
  advertised_compensation: {
    min: string | null;
    max: string | null;
    period: string | null;
    currency: string | null;
  };
  public_listing: boolean;
  posted_at: string;
  updated_at: string;
}
