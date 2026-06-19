// Settings S5c-1 — org-hierarchy HTTP client.
//
// Wires the 3 D4a edge endpoints (GET / POST / DELETE). The picker-
// source 403 fallback uses the SHARED probe from users/users-api.ts
// (extracted at S5c-2 ruling 7 — three S5c surfaces share one probe).

import { apiClient } from '@aramo/fe-foundation';

import type {
  AddEdgeRequest,
  AddEdgeResponse,
  ManagementEdgeListView,
} from './types';

// Re-exports for the org/* call-sites that have used the local probe
// since S5c-1. The canonical home is users/users-api.ts post-S5c-2.
export {
  probeUserRoster,
  type UserRosterState,
} from '../assignments/roster';

export const EDGES_PATH = '/v1/management/edges';

// GET /v1/management/edges — the flat edge list.
export async function fetchManagementEdges(): Promise<ManagementEdgeListView> {
  return apiClient.get<ManagementEdgeListView>(EDGES_PATH);
}

// POST /v1/management/edges — add a manager→report edge.
//
// IDEMPOTENT at the BE: a duplicate (manager, report) pair returns the
// existing edge row with 201 (no audit event). The FE does NOT
// distinguish — both paths refresh the tree (S5c-1 ruling 4).
export async function addManagementEdge(
  body: AddEdgeRequest,
): Promise<AddEdgeResponse> {
  return apiClient.post<AddEdgeResponse>(EDGES_PATH, body);
}

// DELETE /v1/management/edges/:id — remove an edge by id.
//
// A 404 means the edge was already gone (idempotent intent achieved).
// The caller can treat this as success.
export async function deleteManagementEdge(edgeId: string): Promise<void> {
  return apiClient.delete<void>(
    `${EDGES_PATH}/${encodeURIComponent(edgeId)}`,
  );
}
