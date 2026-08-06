import { apiClient } from '@aramo/fe-foundation';

import type {
  PlacementEventListResponse,
  PlacementListResponse,
  PlacementView,
} from './types';

// E1-d — the ats-web placement read client (the first real consumer of the
// /v1/placements read surface). Cookie auth is applied by the foundation
// client. These are the exact requests the ats-web board issues; the Pact
// consumer contract (pact/consumers/ats-web/src/placement.consumer.test.ts)
// pins their shape against aramo-core.

// Collection read — the actor's visible placements, optionally narrowed by an
// indexed axis. The board groups by requisition_id for the derived display.
export async function listPlacements(filter?: {
  requisition_id?: string;
  submittal_id?: string;
  talent_record_id?: string;
}): Promise<PlacementListResponse> {
  const params = new URLSearchParams();
  if (filter?.requisition_id) params.set('requisition_id', filter.requisition_id);
  if (filter?.submittal_id) params.set('submittal_id', filter.submittal_id);
  if (filter?.talent_record_id) params.set('talent_record_id', filter.talent_record_id);
  const qs = params.toString();
  return apiClient.get<PlacementListResponse>(`/v1/placements${qs ? `?${qs}` : ''}`);
}

// Item read — a single placement (no reason evidence on this surface).
export async function getPlacement(id: string): Promise<PlacementView> {
  return apiClient.get<PlacementView>(`/v1/placements/${encodeURIComponent(id)}`);
}

// Event/reason timeline — the AUTHORIZED detail surface. reason_code /
// reason_label_snapshot / permitted reason_detail appear only here, and only
// on the placement detail view — never on collection rows or board cards.
export async function listPlacementEvents(id: string): Promise<PlacementEventListResponse> {
  return apiClient.get<PlacementEventListResponse>(
    `/v1/placements/${encodeURIComponent(id)}/events`,
  );
}
