// Settings S5b — tenant user-management HTTP client.
//
// Wires the existing endpoints (S5-BE1 + S3a + S3b); S5b adds no
// backend route. Plus a courtesy probe of the financials toggle via
// the S1 GET /v1/tenant/settings — ruling 4 lets a 403 fall through
// gracefully (a pure user-manage admin without tenant:admin:settings
// scope cannot read the setting; the BE rejection is the source of
// truth).

import { ApiError, apiClient } from '../api/client';

import type {
  AssignRolesRequest,
  AssignRolesResponse,
  DisableResponse,
  InviteRequest,
  InviteResponse,
  TenantUserListView,
  TenantUserView,
} from './types';

export const USERS_PATH = '/v1/tenant/users';
export const SETTINGS_PATH = '/v1/tenant/settings';

// GET /v1/tenant/users — the roster.
export async function fetchTenantUsers(): Promise<TenantUserListView> {
  return apiClient.get<TenantUserListView>(USERS_PATH);
}

// GET /v1/tenant/users/:user_id — single row (currently unused in S5b's
// list-centric layout, but exported for spec coverage + future detail-
// view consumers).
export async function fetchTenantUser(userId: string): Promise<TenantUserView> {
  return apiClient.get<TenantUserView>(
    `${USERS_PATH}/${encodeURIComponent(userId)}`,
  );
}

// POST /v1/tenant/users/invitations — invite a new tenant user.
export async function inviteTenantUser(
  body: InviteRequest,
): Promise<InviteResponse> {
  return apiClient.post<InviteResponse>(`${USERS_PATH}/invitations`, body);
}

// POST /v1/tenant/users/:user_id/disable — soft-disable a tenant user.
// The optional `reason` rides the body; the BE accepts an absent body.
export async function disableTenantUser(args: {
  userId: string;
  reason: string | null;
}): Promise<DisableResponse> {
  const body = args.reason !== null ? { reason: args.reason } : {};
  return apiClient.post<DisableResponse>(
    `${USERS_PATH}/${encodeURIComponent(args.userId)}/disable`,
    body,
  );
}

// PATCH /v1/tenant/users/:user_id/roles — replace the role-set.
export async function assignTenantUserRoles(args: {
  userId: string;
  body: AssignRolesRequest;
}): Promise<AssignRolesResponse> {
  return apiClient.patch<AssignRolesResponse>(
    `${USERS_PATH}/${encodeURIComponent(args.userId)}/roles`,
    args.body,
  );
}

// Settings S4 — the courtesy probe of the financials toggle (ruling 4).
//
// Try GET /v1/tenant/settings. Two graceful outcomes:
//   - 200 → return the toggle's value (true/false).
//   - 403 → return `unknown` (the caller is a pure user-manage admin
//     without tenant:admin:settings; the proactive-disable falls back
//     to "always show + rely on BE rejection").
//
// Any OTHER error rethrows; this probe is intentionally tolerant of
// 403 only — a 500 here is a real failure the caller surfaces, not a
// reason to silently mis-render the picker.
//
// Return shape:
//   { state: 'known'; enabled: boolean }  — proactive-disable applies.
//   { state: 'unknown' }                  — proactive-disable suppressed;
//                                           BE rejection is the floor.
export type FinancialsToggleState =
  | { state: 'known'; enabled: boolean }
  | { state: 'unknown' };

interface MinimalSettingsView {
  readonly 'audit.financials_enabled'?: boolean;
}

export async function probeFinancialsToggle(): Promise<FinancialsToggleState> {
  try {
    const view = await apiClient.get<MinimalSettingsView>(SETTINGS_PATH);
    const enabled = view['audit.financials_enabled'];
    if (typeof enabled !== 'boolean') {
      // A future backend that drops the key — fall back to unknown.
      return { state: 'unknown' };
    }
    return { state: 'known', enabled };
  } catch (err: unknown) {
    if (err instanceof ApiError && err.status === 403) {
      return { state: 'unknown' };
    }
    throw err;
  }
}
