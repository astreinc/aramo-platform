import { apiClient } from '@aramo/fe-foundation';

import type { DashboardView } from './types';

// R-home — the GET /v1/dashboard wrapper. Single endpoint, single payload;
// the BE bundles the 6 metrics so the FE doesn't N-round-trip on load.
// Visibility is server-side (recruiter sees own-assigned rollups;
// requisition:read:all holders see tenant-wide) — the FE just renders.
export async function getDashboard(): Promise<DashboardView> {
  return apiClient.get<DashboardView>('/v1/dashboard');
}
