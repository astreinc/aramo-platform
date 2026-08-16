import { apiClient } from '@aramo/fe-foundation';

import type { FallthroughReport } from './fallthrough-types';

// T9-B2 — GET /v1/reports/fallthrough (report:read). `from`/`to` are absolute
// ISO instants (carry Z); the server cohorts placement attempts by first
// OFFER_ACCEPTED ∈ [from,to). Visibility is server-side (tenant / site / A3) —
// the FE just renders. reason_detail is never returned.
export async function getFallthrough(
  fromIso: string,
  toIso: string,
): Promise<FallthroughReport> {
  const qs = new URLSearchParams({ from: fromIso, to: toIso }).toString();
  return apiClient.get<FallthroughReport>(`/v1/reports/fallthrough?${qs}`);
}
