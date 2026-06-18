import { apiClient } from '@aramo/fe-foundation';

import type { DashboardView, RecruiterMetricsReportView } from './types';

// R-home — the GET /v1/dashboard wrapper. Single endpoint, single payload;
// the BE bundles the 6 metrics so the FE doesn't N-round-trip on load.
// Visibility is server-side (recruiter sees own-assigned rollups;
// requisition:read:all holders see tenant-wide) — the FE just renders.
export async function getDashboard(): Promise<DashboardView> {
  return apiClient.get<DashboardView>('/v1/dashboard');
}

// R-home KPI header — GET /v1/reports/recruiter-metrics (report:read). The
// principal-scoped Submittals·wk / Interviews set / Placements·MTD /
// Avg-time-to-submit, each with the prior period (delta), a series (sparkline)
// and the tenant-default goal. Degrades independently of the dashboard call.
export async function getRecruiterMetrics(): Promise<RecruiterMetricsReportView> {
  return apiClient.get<RecruiterMetricsReportView>(
    '/v1/reports/recruiter-metrics',
  );
}
