// Offer Lifecycle (D7) — the FE mirror of the BE OfferState value space
// (libs/placement/src/lib/lifecycle/offer-lifecycle.ts OFFER_STATES). ats-web
// cannot import @aramo/placement (a forbidden domain edge), so the value space is
// hand-mirrored; keep it 1:1 with the BE registry.
export const OFFER_STATES = [
  'DRAFT',
  'SENT',
  'NEGOTIATION',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'RESCINDED',
] as const;
export type OfferState = (typeof OFFER_STATES)[number];

// Hand-mirror of the canonical offer-timing semantic (libs/placement
// offer-timing.ts OfferTiming). The SERVER derives this from (state,
// offer_expires_at, now) — the FE renders it and NEVER recomputes "expiring soon"
// or days-left from offer_expires_at itself.
export interface OfferTiming {
  readonly awaiting_response: boolean;
  readonly expiring_soon: boolean;
  readonly expired_by_time: boolean;
  readonly days_until_expiry: number | null;
}

// Hand-mirror of the BE OfferView (libs/placement/src/lib/offer.repository.ts
// OfferView) + the read-layer offer_timing (apps/api OfferReadView). Wire
// read-shape for the /v1/offers surface; keep 1:1 with the BE.
export interface OfferView {
  readonly id: string;
  readonly tenant_id: string;
  readonly submittal_id: string;
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly state: OfferState;
  readonly proposed_start_date: string | null;
  readonly offer_expires_at: string | null;
  readonly client_offer_reference: string | null;
  readonly offer_terms_summary: string | null;
  readonly decline_reason: string | null;
  readonly created_at: string;
  // Server-computed canonical offer timing. Optional on the mirror only so unrelated
  // fixtures need not restate it; GET /v1/offers always populates it.
  readonly offer_timing?: OfferTiming | null;
}

export interface OfferListResponse {
  readonly items: readonly OfferView[];
}

// POST /v1/offers body (CreateOfferDto). submittal_id is resolved FE-side from
// the (talent, requisition) pair via the submittals lookup (D7 R-CREATE-BRIDGE).
export interface CreateOfferRequest {
  readonly submittal_id: string;
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly proposed_start_date?: string;
  readonly offer_expires_at?: string;
  readonly client_offer_reference?: string;
  readonly offer_terms_summary?: string;
}

// PATCH /v1/offers/:id body (TransitionOfferDto). to_state is the affordance's
// target; the BE policy + DB trigger own legality.
export interface TransitionOfferRequest {
  readonly to_state: OfferState;
}
