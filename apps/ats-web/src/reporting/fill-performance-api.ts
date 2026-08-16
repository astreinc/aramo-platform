import { apiClient } from '@aramo/fe-foundation';

import type { FillPerformanceReport } from './types';

// T9-B1 — GET /v1/reports/fill-performance (report:read). `from`/`to` are
// absolute ISO instants (carry Z); the server cohorts requisitions by
// created_at ∈ [from,to). Visibility is server-side (tenant / site / A3) — the
// FE just renders.
export async function getFillPerformance(
  fromIso: string,
  toIso: string,
): Promise<FillPerformanceReport> {
  const qs = new URLSearchParams({ from: fromIso, to: toIso }).toString();
  return apiClient.get<FillPerformanceReport>(
    `/v1/reports/fill-performance?${qs}`,
  );
}
