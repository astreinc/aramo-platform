// Settings Rebuild Directive 5 — roles-catalog read client (the single source
// for the FE roles surfaces: the user-management RolePicker + the read-only
// Roles & permissions matrix). Closes the hand-mirror drift.
//
//   GET /v1/tenant/roles-catalog -> { roles: RoleCatalogView[] }
//
// Gates on tenant:admin:user-manage (reused — Lead ruling B).

import { apiClient } from '@aramo/fe-foundation';

// Hand-mirror of libs/identity RoleCatalogView (leaf consumer of the HTTP
// surface). NOTE: this is a stable READ shape, not the role DATA — the data
// (keys, descriptions, scope bundles) comes from the endpoint, so there is no
// drift to guard.
export interface RoleCatalogScopeGate {
  readonly setting_key: 'audit.financials_enabled';
  readonly disabled_message: string;
}

export interface RoleCatalogView {
  readonly key: string;
  readonly display: string;
  readonly description: string;
  readonly tier: string;
  readonly scopes: readonly string[];
  readonly requires_setting?: RoleCatalogScopeGate;
}

export const ROLES_CATALOG_PATH = '/v1/tenant/roles-catalog';

export async function fetchRolesCatalog(): Promise<readonly RoleCatalogView[]> {
  const res = await apiClient.get<{ roles?: RoleCatalogView[] }>(ROLES_CATALOG_PATH);
  return res.roles ?? [];
}
