import { apiClient } from '@aramo/fe-foundation';

import type { SubmittalWorkspaceView } from './submittal-workspace-types';

// SW-5 — the Submittal Workspace read. One GET against the SW-4 projection; the FE
// renders the returned sections without re-deriving business meaning. Tenant +
// requisition visibility + field-level commercial authorization are all resolved
// server-side — the FE trusts the composed payload.
export async function getSubmittalWorkspace(
  submittalId: string,
): Promise<SubmittalWorkspaceView> {
  return apiClient.get<SubmittalWorkspaceView>(
    `/v1/submittals/${encodeURIComponent(submittalId)}/workspace`,
  );
}
