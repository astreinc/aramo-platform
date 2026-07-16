import { apiClient } from '@aramo/fe-foundation';

// Portal P1 PR-3 / P2 P2b — typed client for the talent-facing portal surface.
// Two backends: the passwordless login request goes to auth-service
// (/auth/portal/*), the record + consent reads/writes go to apps/api
// (/v1/portal/*, proxied to :3000 in dev). All calls ride the shared HttpOnly
// session cookie via apiClient (no bearer in JS).
//
// The record shape is the closed PortalProfile envelope from openapi/portal.yaml
// (additionalProperties:false, R10-filtered). Portal P2 P2b lands tenant_name
// (the P1-deferred MAY → MUST): the engagement counterparty is named.

// Closed vocab mirrors (source of truth: openapi/common.yaml).
export type ConsentScope =
  | 'profile_storage'
  | 'resume_processing'
  | 'matching'
  | 'contacting'
  | 'cross_tenant_visibility';

export type ConsentScopeStatus = 'granted' | 'revoked' | 'expired' | 'no_grant';

export interface PortalRecordProfile {
  talent_id: string;
  tenant_id: string;
  tenant_name: string | null;
  tenant_status: string;
  source_channel: string;
  created_at: string;
}

export interface PortalRecordsResponse {
  records: PortalRecordProfile[];
}

export interface ConsentScopeState {
  scope: ConsentScope;
  status: ConsentScopeStatus;
  granted_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
}

export interface TalentConsentState {
  talent_record_id: string;
  tenant_id: string;
  is_anonymized: boolean;
  computed_at: string;
  scopes: ConsentScopeState[];
}

export interface PortalConsentTextEntry {
  scope: ConsentScope;
  text: string;
}

export interface PortalConsentText {
  version: string;
  texts: PortalConsentTextEntry[];
}

export interface ConsentHistoryEvent {
  event_id: string;
  scope: ConsentScope;
  action: string; // granted | revoked | expired
  created_at: string;
  expires_at: string | null;
}

export interface ConsentHistoryResponse {
  events: ConsentHistoryEvent[];
  next_cursor: string | null;
  is_anonymized: boolean;
}

export interface PortalConsentMutation {
  scope: ConsentScope;
  action: 'granted' | 'revoked';
  occurred_at: string;
  expires_at: string | null;
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

  // Portal P2 P2b — one record's consent state (all 5 scopes, honest
  // active/expired/revoked/no_grant derivation).
  getRecordConsent(id: string): Promise<TalentConsentState> {
    return apiClient.get(`/v1/portal/records/${id}/consent`);
  },

  // Portal P2 P2b — the EXACT versioned consent text per scope (the D7 hash
  // preimage). The grant flow displays the bytes verbatim for the scope granted.
  getConsentText(id: string): Promise<PortalConsentText> {
    return apiClient.get(`/v1/portal/records/${id}/consent/text`);
  },

  // Portal P2 P2b — the append-only consent history (engagement-class events).
  getConsentHistory(id: string): Promise<ConsentHistoryResponse> {
    return apiClient.get(`/v1/portal/records/${id}/consent/history`);
  },

  // Portal P2 P2b — grant consent for one scope. Idempotency-Key is a per-submit
  // UUID (the contract requires it); the version is the text the user saw.
  grantConsent(
    id: string,
    scope: ConsentScope,
    consentTextVersion: string,
    idempotencyKey: string,
  ): Promise<PortalConsentMutation> {
    return apiClient.post(
      `/v1/portal/records/${id}/consent/grant`,
      { scope, consent_text_version: consentTextVersion },
      { headers: { 'Idempotency-Key': idempotencyKey } },
    );
  },

  // Portal P2 P2b — revoke consent for one scope (immediate + idempotent).
  revokeConsent(
    id: string,
    scope: ConsentScope,
    idempotencyKey: string,
  ): Promise<PortalConsentMutation> {
    return apiClient.post(
      `/v1/portal/records/${id}/consent/revoke`,
      { scope },
      { headers: { 'Idempotency-Key': idempotencyKey } },
    );
  },
};
