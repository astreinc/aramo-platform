import { apiClient } from '@aramo/fe-foundation';

// SW-6 — the FE client for the GOVERNED process-level ClientSelection commands that
// had no FE yet (LATENT). The backend remains authoritative: these echo the
// optimistic-concurrency version (expected_version) and the server enforces legal
// transitions, scopes, and closed withdrawal reason codes. The FE renders a CTA only
// when the workspace projection's server-owned available_actions flag is true, then
// refetches the workspace on success. A stale version → 409
// CLIENT_SELECTION_TRANSITION_CONFLICT (surfaced as a refresh, never forced locally).

// The authoritative process shape these return (we only consume state/version; the
// page refetches the composed workspace for the full truth).
export interface ClientSelectionProcessResult {
  readonly id: string;
  readonly state: string;
  readonly version: number;
}

// POST /v1/client-selection/:id/transition — the lifecycle-forward commands that are
// NOT a disposition: CLIENT_REVIEW→INTERVIEW and →SELECTED. DECLINED/WITHDRAWN are
// refused here (422) and MUST use decideClientSelection.
export async function transitionClientSelection(
  processId: string,
  body: { readonly to_state: 'INTERVIEW' | 'SELECTED'; readonly expected_version: number; readonly note?: string },
): Promise<ClientSelectionProcessResult> {
  return apiClient.post<ClientSelectionProcessResult>(
    `/v1/client-selection/${encodeURIComponent(processId)}/transition`,
    body,
  );
}

// POST /v1/client-selection/:id/decision — the governed client-decision dispositions
// DECLINED / WITHDRAWN. WITHDRAWN requires a closed reason_code (the server validates).
export async function decideClientSelection(
  processId: string,
  body: {
    readonly to_state: 'DECLINED' | 'WITHDRAWN';
    readonly expected_version: number;
    readonly reason_code?: string;
    readonly note?: string;
  },
): Promise<ClientSelectionProcessResult> {
  return apiClient.post<ClientSelectionProcessResult>(
    `/v1/client-selection/${encodeURIComponent(processId)}/decision`,
    body,
  );
}
