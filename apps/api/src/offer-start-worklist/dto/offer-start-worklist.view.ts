// Offer & Start §9 — the cross-requisition Offer & Start WORKLIST read contract. This is a
// READ-ONLY projection over existing authorities (ClientSelection/Offer/Placement/Talent/
// Requisition) composed in apps/api; it owns NO lifecycle, persists NO status, and is NOT a
// Placement authority (a row may have an Offer but no PlacementProcess yet — PO ruling). Every
// row deep-links to the SAME person × requisition journey at /offer-start/:pipeline_id.

// The worklist phase — presentation vocabulary derived from the DEEPEST authoritative owner
// (Placement over Offer). It is NOT a stored status and NOT a new lifecycle enum: it is a
// read-time label the list sorts/groups by. Exceptions (BLOCKED / DECLINED / EXPIRED) are
// first-class so the surface is exception-first (§9.3/§9.6).
export type WorklistPhase =
  | 'OFFER'
  | 'ACCEPTED'
  | 'PRE_START'
  | 'READY'
  | 'STARTED'
  | 'BLOCKED'
  | 'OFFER_DECLINED'
  | 'OFFER_EXPIRED';

export interface OfferStartWorklistRow {
  // The journey deep-link key (pipeline episode). Null only if the episode is unresolvable
  // (e.g. a voided episode) — the FE then renders the row without a deep-link rather than guess.
  readonly pipeline_id: string | null;
  readonly requisition_id: string;
  readonly requisition_number: number | null;
  readonly requisition_title: string | null;
  readonly client_name: string | null;
  readonly talent_record_id: string;
  readonly talent_name: string | null;
  readonly phase: WorklistPhase;
  readonly phase_label: string;
  readonly engagement: 'CONTRACT' | 'PERMANENT' | null;
  readonly has_exception: boolean;
  readonly exception_summary: string | null;
  // The owner row's recency, for the secondary sort (exception-first, then most-recent).
  readonly updated_at: string | null;
}

export interface OfferStartWorklistResponse {
  readonly items: readonly OfferStartWorklistRow[];
  // The number of rows returned (bounded by the server limit) — a display count, never a stored total.
  readonly total: number;
}
