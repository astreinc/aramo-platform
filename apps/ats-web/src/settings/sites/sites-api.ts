// Settings Rebuild Directive 4 — sites/branches CRUD client.
//
//   GET    /v1/tenant/sites                 -> SiteListView
//   POST   /v1/tenant/sites                 -> SiteView (201)
//   PATCH  /v1/tenant/sites/:id  (partial)  -> SiteView
//   POST   /v1/tenant/sites/:id/deactivate  -> SiteView
//   POST   /v1/tenant/sites/:id/reactivate  -> SiteView
//   DELETE /v1/tenant/sites/:id             -> 204 (or 400 site_in_use)
//
// Gates on tenant:admin:sites (the dedicated sites admin scope). The FE
// AdminGate covers it via the tenant:admin:* family, so the server is the
// real gate and these calls surface its 4xx as ApiError.

import { apiClient } from '@aramo/fe-foundation';

import type {
  CreateSiteRequest,
  SiteListView,
  SiteView,
  UpdateSiteRequest,
} from './types';

export const SITES_PATH = '/v1/tenant/sites';

export function fetchSites(): Promise<SiteListView> {
  return apiClient.get<SiteListView>(SITES_PATH);
}

// REJECTED with 400 on a duplicate name in the tenant (a genuine collision,
// not an idempotent no-op) — the mapper reads details.reason.
export function createSite(body: CreateSiteRequest): Promise<SiteView> {
  return apiClient.post<SiteView>(SITES_PATH, body);
}

export function updateSite(
  id: string,
  body: UpdateSiteRequest,
): Promise<SiteView> {
  return apiClient.patch<SiteView>(
    `${SITES_PATH}/${encodeURIComponent(id)}`,
    body,
  );
}

export function deactivateSite(id: string): Promise<SiteView> {
  return apiClient.post<SiteView>(
    `${SITES_PATH}/${encodeURIComponent(id)}/deactivate`,
    {},
  );
}

export function reactivateSite(id: string): Promise<SiteView> {
  return apiClient.post<SiteView>(
    `${SITES_PATH}/${encodeURIComponent(id)}/reactivate`,
    {},
  );
}

// Hard-delete. A site referenced by members or with child branches returns
// 400 (reason: site_in_use) — the caller surfaces the "deactivate instead"
// guidance rather than orphaning the references.
export function deleteSite(id: string): Promise<void> {
  return apiClient.delete<void>(`${SITES_PATH}/${encodeURIComponent(id)}`);
}
