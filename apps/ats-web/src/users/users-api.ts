// Settings S5b — tenant user-management HTTP client.
//
// Wires the existing endpoints (S5-BE1 + S3a + S3b); S5b adds no
// backend route. Plus a courtesy probe of the financials toggle via
// the S1 GET /v1/tenant/settings — ruling 4 lets a 403 fall through
// gracefully (a pure user-manage admin without tenant:admin:settings
// scope cannot read the setting; the BE rejection is the source of
// truth).

import { ApiError, apiClient } from '@aramo/fe-foundation';

import { fetchRolesCatalog } from '../settings/roles/roles-catalog-api';

import type {
  AssignRolesRequest,
  AssignRolesResponse,
  DisableResponse,
  InviteRequest,
  InviteResponse,
  TenantRoleCatalogEntry,
  TenantUserListView,
  TenantUserView,
} from './types';

export const USERS_PATH = '/v1/tenant/users';
export const SETTINGS_PATH = '/v1/tenant/settings';
export const ASSIGNABLE_USERS_PATH = '/v1/tenant/assignable-users';
export const DIRECTORY_PATH = '/v1/tenant/users/directory';

// §5 Auth-Hardening D4 — the ONE shared PICKER source ("who can I assign to?").
// GET /v1/tenant/assignable-users returns the MINIMAL roster ({user_id,
// display_name}) of ACTIVE members; with a company_id (the requisition picker
// passes the req's client) it narrows to client-mapped + req-carrying members.
// Every work-assigning role holds tenant:user:read:assignable, so the picker
// always resolves a real roster — no admin-endpoint 403-fallback.
export interface AssignableUser {
  readonly user_id: string;
  readonly display_name: string | null;
}

export async function fetchAssignableUsers(
  companyId?: string,
): Promise<readonly AssignableUser[]> {
  const path =
    companyId !== undefined && companyId.length > 0
      ? `${ASSIGNABLE_USERS_PATH}?company_id=${encodeURIComponent(companyId)}`
      : ASSIGNABLE_USERS_PATH;
  const view = await apiClient.get<{ items?: readonly AssignableUser[] }>(path);
  return view.items ?? [];
}

// §5 Auth-Hardening D4b/4c — the ONE shared NAME-RESOLVER source ("whose name
// is this?"). GET /v1/tenant/users/directory resolves user_id → display_name
// for ALL tenant users INCLUDING inactive/departed (historical integrity: a
// record's author/owner/assignee renders even after they leave). BATCH: pass
// the visible rows' ids → one call, not per-row. Returns an id→name map
// (display_name may be null → the caller falls back to the id). An empty id
// set short-circuits (no call). The directory read scope
// (tenant:user:read:directory) is held by the list-view tier.
export interface DirectoryUser {
  readonly user_id: string;
  readonly display_name: string | null;
}

export async function resolveUserNames(
  userIds?: readonly string[],
): Promise<Record<string, string>> {
  let path = DIRECTORY_PATH;
  if (userIds !== undefined) {
    // BATCH form: resolve exactly the given ids (a small, known set — e.g. the
    // assigned users on an assignment view).
    const unique = [...new Set(userIds.filter((id) => id.length > 0))];
    if (unique.length === 0) return {};
    path = `${DIRECTORY_PATH}?user_ids=${encodeURIComponent(unique.join(','))}`;
  }
  // No ids → the whole-tenant directory (the one-shot full-map form the
  // list/detail views use: they resolve names from MULTIPLE, partly-async id
  // sources — owner + account team + recruiter + pipeline owners — so a single
  // map keyed by all tenant users, incl. inactive, is the natural fit; one call,
  // no per-row fetch). Same shape as the prior fetch-all probe, now on the
  // all-users directory so departed authors/owners still render.
  //
  // Best-effort: name resolution NEVER blocks a surface — on any failure the
  // map is empty and the caller falls back to the id (mirrors the prior probe's
  // graceful degrade; no unhandled rejection).
  try {
    const view = await apiClient.get<{ items?: readonly DirectoryUser[] }>(path);
    const map: Record<string, string> = {};
    for (const u of view.items ?? []) {
      if (u.display_name !== null) map[u.user_id] = u.display_name;
    }
    return map;
  } catch {
    return {};
  }
}

// Settings Rebuild D5 — the RolePicker's role list, sourced from the backend
// roles-catalog (closes the hand-mirror drift). Maps the catalog view to the
// picker's row shape.
export async function fetchPickerRoles(): Promise<readonly TenantRoleCatalogEntry[]> {
  const roles = await fetchRolesCatalog();
  return roles.map((r) => ({
    key: r.key,
    label: r.display,
    description: r.description,
    ...(r.requires_setting
      ? {
          helper: r.requires_setting.disabled_message,
          requiresSetting: {
            key: r.requires_setting.setting_key,
            disabledMessage: r.requires_setting.disabled_message,
          },
        }
      : {}),
  }));
}

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

// §5 Auth-Hardening D4c — the admin-gated probeUserRoster (the S5c shared
// roster probe over GET /v1/tenant/users) is RETIRED. The pickers source
// fetchAssignableUsers (above); name display sources resolveUserNames (above).
