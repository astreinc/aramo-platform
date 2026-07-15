import { apiClient } from '@aramo/fe-foundation';

// Portal P1 PR-3 — typed client for the talent-facing portal surface. Two
// backends: the passwordless login request goes to auth-service (/auth/portal/*),
// the record reads go to apps/api (/v1/portal/*, proxied to :3000 in dev). All
// calls ride the shared HttpOnly session cookie via apiClient (no bearer in JS).
//
// The record shape is the closed PortalProfile envelope from openapi/portal.yaml
// (additionalProperties:false, R10-filtered). tenant_name is deliberately NOT a
// field — P-R5 permits naming the engagement counterparty but PR-2a deferred it
// (P2 ledger), so the portal shows the tenant id until the name lands.

export interface PortalRecordProfile {
  talent_id: string;
  tenant_id: string;
  tenant_status: string;
  source_channel: string;
  created_at: string;
}

export interface PortalRecordsResponse {
  records: PortalRecordProfile[];
}

export const portalApi = {
  // Passwordless sign-in: request a magic link. The response is byte-identical
  // whether the address is eligible, ineligible, or malformed (oracle-resistance,
  // Portal P1 ruling 2) — the caller never branches on it, always showing the
  // same neutral confirmation.
  async requestLink(email: string): Promise<void> {
    await apiClient.post('/auth/portal/request-link', { email });
  },

  // The talent's records across tenants (engagement surface, P-R5). Empty is a
  // valid state (a portal user with no live records), not an error.
  listRecords(): Promise<PortalRecordsResponse> {
    return apiClient.get('/v1/portal/records');
  },

  // One record's R10-filtered profile. An id not reachable through the caller's
  // chain is a uniform 404 (surfaced as an ApiError the view renders honestly).
  getRecordProfile(id: string): Promise<PortalRecordProfile> {
    return apiClient.get(`/v1/portal/records/${id}/profile`);
  },
};
