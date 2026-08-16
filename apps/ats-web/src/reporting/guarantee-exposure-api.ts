import { apiClient } from '@aramo/fe-foundation';

import type { GuaranteeExposureReport } from './guarantee-exposure-types';

// Track 7 / T7-P5 — GET /v1/reports/guarantee-exposure (report:read). `from`/`to` are absolute
// ISO instants (carry Z); the server cohorts PermanentPlacements by created_at ∈ [from,to).
// Visibility is server-side (tenant / site / A3). Summary-only; the FE just renders.
export async function getGuaranteeExposure(
  fromIso: string,
  toIso: string,
): Promise<GuaranteeExposureReport> {
  const qs = new URLSearchParams({ from: fromIso, to: toIso }).toString();
  return apiClient.get<GuaranteeExposureReport>(`/v1/reports/guarantee-exposure?${qs}`);
}
