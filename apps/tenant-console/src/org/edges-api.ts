// Settings S5c-1 — org-hierarchy HTTP client.
//
// Wires the 3 D4a edge endpoints (GET / POST / DELETE) + the courtesy
// probe of `GET /v1/tenant/users` (S5-BE1) for the picker source.
//
// PL-94 §2 ruling 6 — picker-source 403 fallback. The view is gated
// `org:manage` but the user-roster GET is gated `tenant:admin:user-
// manage` — a DIFFERENT scope. We try-read; on 403 we return
// `{ state: 'forbidden' }` and the AddEdgeDialog degrades to raw-UUID
// inputs. The S5b S4-toggle precedent.

import { ApiError, apiClient } from '../api/client';

import type {
  AddEdgeRequest,
  AddEdgeResponse,
  ManagementEdgeListView,
  UserRosterState,
} from './types';

export const EDGES_PATH = '/v1/management/edges';
export const USERS_PATH = '/v1/tenant/users';

// GET /v1/management/edges — the flat edge list.
export async function fetchManagementEdges(): Promise<ManagementEdgeListView> {
  return apiClient.get<ManagementEdgeListView>(EDGES_PATH);
}

// POST /v1/management/edges — add a manager→report edge.
//
// IDEMPOTENT at the BE: a duplicate (manager, report) pair returns the
// existing edge row with 201 (no audit event). The FE does NOT
// distinguish — both paths refresh the tree (PL-94 §2 ruling 4).
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

// Settings S5c-1 ruling 6 — the courtesy probe of the user roster.
//
// Try `GET /v1/tenant/users`. Two graceful outcomes:
//   - 200 → return { state: 'ready', users }; rich name selects.
//   - 403 → return { state: 'forbidden' }; raw-UUID input fallback.
//
// Any OTHER error rethrows; a 500 here is a real failure the caller
// surfaces, not a reason to silently mis-render.

interface MinimalUsersView {
  readonly items?: ReadonlyArray<{
    readonly user_id: string;
    readonly email: string;
    readonly display_name: string | null;
    readonly is_active: boolean;
    readonly deactivated_at: string | null;
    readonly site_id: string | null;
    readonly role_keys: readonly string[];
  }>;
}

export async function probeUserRoster(): Promise<UserRosterState> {
  try {
    const view = await apiClient.get<MinimalUsersView>(USERS_PATH);
    const items = view.items ?? [];
    return { state: 'ready', users: items };
  } catch (err: unknown) {
    if (err instanceof ApiError && err.status === 403) {
      return { state: 'forbidden' };
    }
    throw err;
  }
}
