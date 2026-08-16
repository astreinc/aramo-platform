import { apiClient } from '@aramo/fe-foundation';

import type { PermanentPlacementResponse, PermanentPlacementView } from './permanent-placement-types';

// Track 7 / T7-P5 — the ats-web permanent-placement client (the first real consumer of the T7
// permanent surface). Cookie auth is applied by the foundation client. These are the exact
// requests the placement detail + lifecycle dialogs issue; the Pact consumer contract
// (pact/consumers/ats-web/src/permanent-placement.consumer.test.ts) pins their shape against
// aramo-core. No amount is ever sent on any mutation — the server owns the obligation amount
// and the acting principal (recorded_by/completed_by = JWT sub).

// GET /v1/placements/:id/permanent (placement:permanent:read + RequireSiteMatch). Returns a
// coherent { permanent: null } for a CONTRACT/legacy placement (a real absence). This is the
// discriminator the detail view uses to branch permanent vs contract — the caller only issues
// it when the principal holds placement:permanent:read.
export async function getPermanentPlacement(id: string): Promise<PermanentPlacementResponse> {
  return apiClient.get<PermanentPlacementResponse>(
    `/v1/placements/${encodeURIComponent(id)}/permanent`,
  );
}

// POST /v1/placements/:id/permanent/transition (placement:permanent:transition). P5 uses only
// the satisfy edge GUARANTEE_ACTIVE -> GUARANTEE_SATISFIED (allowed on/after the guarantee end
// date; a premature satisfy is a governed 422). No caller-supplied actor. Returns the refreshed
// PermanentPlacementView.
export async function satisfyGuarantee(id: string): Promise<PermanentPlacementView> {
  return apiClient.post<PermanentPlacementView>(
    `/v1/placements/${encodeURIComponent(id)}/permanent/transition`,
    { to: 'GUARANTEE_SATISFIED' },
  );
}

// POST /v1/placements/:id/permanent/falloff (placement:permanent:transition). Records a
// qualifying post-start falloff: a calendar effective date in the half-open guarantee window +
// a governed closed-registry reason code; the command atomically lands the deterministic
// remedy-due state. recorded_by = JWT sub. Governed 422 on out-of-window date / ungoverned
// reason.
export async function recordFalloff(
  id: string,
  body: { effective_date: string; reason: string },
): Promise<PermanentPlacementView> {
  return apiClient.post<PermanentPlacementView>(
    `/v1/placements/${encodeURIComponent(id)}/permanent/falloff`,
    body,
  );
}

// POST /v1/placements/:id/permanent/remedy/complete (placement:remedy:resolve). Evidence-gated:
// REPLACEMENT requires a governed replacement placement-process reference (server validates
// same-tenant / same-requisition / PERMANENT / STARTED); REFUND / PRORATED_CREDIT require a
// bounded external_reference. The caller NEVER supplies the amount; completed_by = JWT sub.
// Double completion is a 409; invalid evidence is a 422 with a details.reason. Returns the
// refreshed PermanentPlacementView.
export async function completeRemedy(
  id: string,
  body: { replacement_placement_process_id?: string; external_reference?: string },
): Promise<PermanentPlacementView> {
  return apiClient.post<PermanentPlacementView>(
    `/v1/placements/${encodeURIComponent(id)}/permanent/remedy/complete`,
    body,
  );
}
