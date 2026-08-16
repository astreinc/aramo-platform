import { apiClient } from '@aramo/fe-foundation';

import type {
  AssignmentCommercialCreatedResponse,
  AssignmentCommercialResponse,
  AssignmentCommercialSeriesResponse,
  CommercialRevisionCancelRequest,
  CommercialRevisionCreateRequest,
  ContractAssignmentEndReason,
  ConvertToPermanentResponse,
  PlacementAssignmentResponse,
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

// Track 4 — the ContractAssignment read (assignment:read). Returns a coherent
// { assignment: null } when no assignment has started for the placement (a real
// absence, never a fabricated row). Capacity is deliberately absent from this
// surface and is never re-derived here.
export async function getPlacementAssignment(
  id: string,
): Promise<PlacementAssignmentResponse> {
  return apiClient.get<PlacementAssignmentResponse>(
    `/v1/placements/${encodeURIComponent(id)}/assignment`,
  );
}

// Track 5 / T5-P3 — the commercial projection read (assignment:commercials:read, a
// DEDICATED financial scope; assignment:read / placement:read do NOT satisfy it).
// Returns a coherent { commercials: null } when the placement has no assignment or no
// active commercial version. The BE derives spread/margin/markup and fails closed
// (INTERNAL_ERROR) on overlapping effective versions — the client renders the returned
// values verbatim and never recomputes or picks a version.
export async function getPlacementAssignmentCommercials(
  id: string,
): Promise<AssignmentCommercialResponse> {
  return apiClient.get<AssignmentCommercialResponse>(
    `/v1/placements/${encodeURIComponent(id)}/assignment/commercials`,
  );
}

// Track 6 / T6-B4 §14 — the non-cancelled commercial revision SERIES
// (GET .../assignment/commercials/revisions, assignment:commercials:read). Historical +
// current + future versions, effective_from DESC; a visible placement with no assignment
// or no versions returns { items: [] }. Rides the compensation mask like the singular read.
export async function listAssignmentCommercialRevisions(
  id: string,
): Promise<AssignmentCommercialSeriesResponse> {
  return apiClient.get<AssignmentCommercialSeriesResponse>(
    `/v1/placements/${encodeURIComponent(id)}/assignment/commercials/revisions`,
  );
}

// Track 6 / T6-B4 §14 amendment — create a governed post-start commercial revision
// (POST .../assignment/commercials/revisions, assignment:commercials:write). B4 v1 is
// Effective-now ONLY: the request DELIBERATELY omits effective_from (the type has no such
// field), so the server supplies the authoritative instant (Amendment §4). Returns the
// new current version. recorded_by is the JWT subject, never the wire.
export async function createAssignmentCommercialRevision(
  id: string,
  body: CommercialRevisionCreateRequest,
): Promise<AssignmentCommercialCreatedResponse> {
  return apiClient.post<AssignmentCommercialCreatedResponse>(
    `/v1/placements/${encodeURIComponent(id)}/assignment/commercials/revisions`,
    body,
  );
}

// Track 6 / T6-B4 §14 — cancel a future open-tail commercial revision
// (POST .../revisions/:revisionId/cancel, assignment:commercials:write). The only wire
// field is the user-selectable cancellation reason; cancelled_by is the JWT subject. The
// server re-opens the predecessor and returns the refreshed non-cancelled series.
export async function cancelAssignmentCommercialRevision(
  id: string,
  revisionId: string,
  body: CommercialRevisionCancelRequest,
): Promise<AssignmentCommercialSeriesResponse> {
  return apiClient.post<AssignmentCommercialSeriesResponse>(
    `/v1/placements/${encodeURIComponent(id)}/assignment/commercials/revisions/${encodeURIComponent(revisionId)}/cancel`,
    body,
  );
}

// Track 4 — end an ACTIVE ContractAssignment (assignment:end). The BE authorizes
// this with the DEDICATED assignment:end scope (placement:* does NOT satisfy it)
// and refuses a non-ACTIVE assignment with 404. end_reason is constrained to the
// authoritative taxonomy. The caller re-reads the authoritative assignment after
// success — the ENDED state is server truth, never manufactured on the client.
export async function endPlacementAssignment(
  id: string,
  endReason: ContractAssignmentEndReason,
): Promise<{ ok: true }> {
  return apiClient.post<{ ok: true }>(
    `/v1/placements/${encodeURIComponent(id)}/assignment/end`,
    { end_reason: endReason },
  );
}

// Track 7 / T7-PX — convert a started contract placement to permanent. ONE POST (no body:
// the guarantee start date is derived server-side, the terms come from the governed stored
// version, the end reason is fixed, and the actor is the JWT sub). Gated by the EXACT
// conjunction assignment:end AND placement:permanent:transition. The response carries the
// NEW permanent PlacementProcess id — the caller navigates there and re-reads server truth.
export async function convertAssignmentToPermanent(
  id: string,
): Promise<ConvertToPermanentResponse> {
  return apiClient.post<ConvertToPermanentResponse>(
    `/v1/placements/${encodeURIComponent(id)}/assignment/convert-to-permanent`,
    {},
  );
}
