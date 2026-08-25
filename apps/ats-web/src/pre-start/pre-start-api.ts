import { apiClient } from '@aramo/fe-foundation';

import type { PreStartPlacementRequirements } from './types';

// Pre-start-requirement FE read client. Thin wrapper over the governed
// GET /v1/pre-start-requirement/placements/:placementId/requirements surface
// (pre_start_requirement:read). The BE guards + evidence redaction are the
// authority; this is a per-placement read issued LAZILY (only when the
// requisition workspace Pre-Start tab is opened), never at first paint.
export async function getPreStartRequirements(
  placementId: string,
): Promise<PreStartPlacementRequirements> {
  return apiClient.get<PreStartPlacementRequirements>(
    `/v1/pre-start-requirement/placements/${encodeURIComponent(placementId)}/requirements`,
  );
}
