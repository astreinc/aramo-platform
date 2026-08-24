import { apiClient } from '@aramo/fe-foundation';

import type {
  CreateOfferRequest,
  OfferListResponse,
  OfferView,
  TransitionOfferRequest,
} from './types';

// Offer Lifecycle (D7 — LOCKED Aramo-Offer-D7-OfferPanel-Wiring v1.0) FE client.
// Thin wrappers over the governed /v1/offers surface; the BE guards + ADR-0024
// policy + DB lifecycle trigger are the real authority. ats-web hand-mirrors
// the types (no @aramo/placement edge).

// List/filter offers. The recruiter surface passes (requisition_id,
// talent_record_id); the one-live DB trigger guarantees ≤1 non-terminal offer
// per (tenant, submittal), so the container can pick the current offer.
export async function listOffers(params: {
  submittalId?: string;
  requisitionId?: string;
  talentRecordId?: string;
}): Promise<OfferListResponse> {
  const q = new URLSearchParams();
  if (params.submittalId !== undefined) q.set('submittal_id', params.submittalId);
  if (params.requisitionId !== undefined)
    q.set('requisition_id', params.requisitionId);
  if (params.talentRecordId !== undefined)
    q.set('talent_record_id', params.talentRecordId);
  const qs = q.toString();
  return apiClient.get<OfferListResponse>(`/v1/offers${qs ? `?${qs}` : ''}`);
}

export async function readOffer(id: string): Promise<OfferView> {
  return apiClient.get<OfferView>(`/v1/offers/${encodeURIComponent(id)}`);
}

// Create a DRAFT offer (offer:create). submittal_id is resolved by the caller
// (D7 R-CREATE-BRIDGE — findSubmittalForTalentJob).
export async function createOffer(
  body: CreateOfferRequest,
): Promise<OfferView> {
  return apiClient.post<OfferView>('/v1/offers', body);
}

// Drive a governed transition (offer:transition). 403 POLICY_DENIED / 409
// OFFER_ILLEGAL_TRANSITION surface via foundation ApiError; the affordance map
// only offers legal edges, so those are defense-in-depth.
export async function transitionOffer(
  id: string,
  body: TransitionOfferRequest,
): Promise<OfferView> {
  return apiClient.patch<OfferView>(
    `/v1/offers/${encodeURIComponent(id)}`,
    body,
  );
}
