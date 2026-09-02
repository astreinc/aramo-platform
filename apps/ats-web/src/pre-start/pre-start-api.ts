import { apiClient } from '@aramo/fe-foundation';

import type {
  PreStartPlacementRequirements,
  PreStartRequirementView,
  ReopenRequest,
  StatusMoveRequest,
  VerifyRequest,
  WaiveRequest,
} from './types';

// Pre-start-requirement FE client. Thin wrappers over the governed HTTP surface; the
// BE scope guards + evidence redaction + domain floors are the authority. L5-P7: the
// onboarding workspace (the owning surface) uses both the read and the write clients.

const BASE = '/v1/pre-start-requirement';
const req = (id: string) => `${BASE}/requirements/${encodeURIComponent(id)}`;

// Read (pre_start_requirement:read) — issued when the workspace opens.
export async function getPreStartRequirements(
  placementId: string,
): Promise<PreStartPlacementRequirements> {
  return apiClient.get<PreStartPlacementRequirements>(
    `${BASE}/placements/${encodeURIComponent(placementId)}/requirements`,
  );
}

// ---- Governed write actions (L5-P7) --------------------------------------------

// SATISFY (SELF_ATTEST only — the BE refuses a VERIFICATION_REQUIRED one here) / FAIL /
// IN_PROGRESS (pre_start_requirement:act).
export async function statusMoveRequirement(
  instanceId: string,
  body: StatusMoveRequest,
): Promise<PreStartRequirementView> {
  return apiClient.post<PreStartRequirementView>(`${req(instanceId)}/status`, body);
}

// Governed verification of a VERIFICATION_REQUIRED requirement (pre_start_requirement:verify).
export async function verifyRequirement(
  instanceId: string,
  body: VerifyRequest = {},
): Promise<PreStartRequirementView> {
  return apiClient.post<PreStartRequirementView>(`${req(instanceId)}/verify`, body);
}

// Waive (pre_start_requirement:waive_advisory | :waive_blocking, data-dependent).
export async function waiveRequirement(
  instanceId: string,
  body: WaiveRequest,
): Promise<PreStartRequirementView> {
  return apiClient.post<PreStartRequirementView>(`${req(instanceId)}/waive`, body);
}

// Reopen a resolved/failed requirement to PENDING (pre_start_requirement:reopen).
export async function reopenRequirement(
  instanceId: string,
  body: ReopenRequest,
): Promise<PreStartRequirementView> {
  return apiClient.post<PreStartRequirementView>(`${req(instanceId)}/reopen`, body);
}

// Mark the placement READY_TO_START — the fail-closed gate (pre_start_requirement:act).
// Returns the transitioned placement { id, state }. A 409 PRE_START_NOT_READY surfaces
// the gate refusal (details.reason discriminates materialization_absent vs blocking_unresolved).
export async function markPlacementReady(
  placementId: string,
): Promise<{ id: string; state: string }> {
  return apiClient.post<{ id: string; state: string }>(
    `${BASE}/placements/${encodeURIComponent(placementId)}/ready`,
    {},
  );
}
