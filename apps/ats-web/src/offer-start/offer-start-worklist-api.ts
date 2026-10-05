import { apiClient } from '@aramo/fe-foundation';

// Offer & Start §9 — the cross-requisition Offer & Start worklist read client (UI: Placements /
// Offers & Starts). The FE consumes the BE-composed projection as the SINGLE source; it does NOT
// re-derive phase/exception locally and never fetches-all-then-filters. Shape mirrors the apps/api
// OfferStartWorklistResponse contract.

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
  readonly updated_at: string | null;
}

export interface OfferStartWorklistResponse {
  readonly items: readonly OfferStartWorklistRow[];
  readonly total: number;
}

// GET /v1/offer-start-worklist — the cross-requisition worklist for the actor's visible
// requisitions (server-scoped). Requires pipeline:read + the ats capability.
export async function getOfferStartWorklist(): Promise<OfferStartWorklistResponse> {
  return apiClient.get<OfferStartWorklistResponse>('/v1/offer-start-worklist');
}
