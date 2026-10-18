// ATS people-directory reads (product-owned). D-ORG-3: tenant user MANAGEMENT
// (roster, invitations, lifecycle, role assignment, the financials probe) moved
// to libs/org-admin-web (Organization Administration, served at /org/users on
// the App Home). What stays here is what ATS surfaces read to assign work and
// render names — the shared picker + name-resolver sources below. Same import
// path (`../users/users-api`) for every ATS call-site.

import { apiClient } from '@aramo/fe-foundation';

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

// ── ATS-side READS of organization data (product-owned HTTP reads) ──────────
// The company-assignment editor enriches its rows with email + role labels from
// the organization's user roster and roles catalog (try-read; a manager without
// the admin scopes degrades to names only). These are READ clients of the
// organization endpoints — the management surfaces (invite / disable / roles)
// live ONLY in libs/org-admin-web (/org/users); nothing here mutates.
export const USERS_PATH = '/v1/tenant/users';
export const ROLES_CATALOG_PATH = '/v1/tenant/roles-catalog';

/** The roster fields the ATS enrichment reads (hand-mirror subset of TenantUserView). */
export interface TenantUserRosterRow {
  readonly user_id: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly role_keys: readonly string[];
}

// GET /v1/tenant/users — the roster (tenant:admin:user-manage; try-read).
export async function fetchTenantUsers(): Promise<{ readonly items: readonly TenantUserRosterRow[] }> {
  return apiClient.get<{ readonly items: readonly TenantUserRosterRow[] }>(USERS_PATH);
}

/** A role key → display label pair from the roles catalog. */
export interface PickerRole {
  readonly key: string;
  readonly label: string;
}

// GET /v1/tenant/roles-catalog — key → display label (tenant:admin:user-manage; try-read).
export async function fetchPickerRoles(): Promise<readonly PickerRole[]> {
  const res = await apiClient.get<{ roles?: readonly { key: string; display: string }[] }>(ROLES_CATALOG_PATH);
  return (res.roles ?? []).map((r) => ({ key: r.key, label: r.display }));
}
