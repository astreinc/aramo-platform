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

// Portal P3c (§PR-3) — the talent-facing verification view + dispute flows.
// Wire shapes mirror openapi/portal.yaml's CLOSED envelopes by hand (the
// scope:portal wall forbids importing the backend DTOs). Trust-class discipline:
// the verification item carries kind + status + dates ONLY — no verifier, no
// tenant, no strength/tier/band (D3 aggregation, directive ruling 1). The item
// id is an opaque server digest resolved server-side (never a raw PK).
export interface PortalVerificationItem {
  item_id: string; // 64-char hex digest — submitted back to open a dispute
  kind: string; // EMAIL | PHONE | PROFILE_URL
  status: string; // CONFIRMED | PENDING | NONE
  verified_at: string | null;
  first_seen_at: string | null;
}

export interface PortalVerificationsResponse {
  verifications: PortalVerificationItem[];
}

// The talent-visible dispute lifecycle (directive ruling 4). Terminal states
// carry the resolution the talent sees; the underlying TR-15 item states never
// reach the wire.
export type PortalDisputeStatus =
  | 'OPEN'
  | 'UNDER_REVIEW'
  | 'RESOLVED_CORRECTED'
  | 'RESOLVED_UPHELD'
  | 'WITHDRAWN';

// The shared mutation/list envelope — talent-facing only (no SLA clocks, no
// item digest, no tenant/subject/work-item ids: those are stripped server-side).
export interface PortalDisputeMutation {
  dispute_id: string;
  status: PortalDisputeStatus;
  opened_at: string;
}

export interface PortalDisputeListResponse {
  disputes: PortalDisputeMutation[];
}

export interface PortalDisputeStatement {
  statement: string;
  created_at: string;
}

export interface PortalDisputeDetail {
  dispute_id: string;
  status: PortalDisputeStatus;
  opened_at: string;
  resolution_note: string | null; // plain-language note on close; null while open
  statements: PortalDisputeStatement[];
}

// Portal P4a — the public platform notice (version + rendered text).
export interface PortalNotice {
  version: string;
  text: string;
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

  // Portal P4a — the current platform notice (public read; no session required —
  // the endpoint ignores auth). Rendered version + text.
  getNotice(): Promise<PortalNotice> {
    return apiClient.get('/v1/portal/notice');
  },

  // Portal P3c — the talent-level verification view ("verified on Aramo").
  // Aggregated across the caller's chain, deduped by anchor/claim identity. No
  // cluster ⇒ a VALID empty list, not an error.
  getVerifications(): Promise<PortalVerificationsResponse> {
    return apiClient.get('/v1/portal/verifications');
  },

  // Portal P3c — open a dispute on a verification item (open-from-item). The
  // item_id is the opaque digest from the view; a fresh UUID Idempotency-Key
  // rides the contract. An item not in the current view is a uniform 404.
  openDispute(
    itemId: string,
    statement: string,
    idempotencyKey: string,
  ): Promise<PortalDisputeMutation> {
    return apiClient.post(
      '/v1/portal/disputes',
      { item_id: itemId, statement },
      { headers: { 'Idempotency-Key': idempotencyKey } },
    );
  },

  // Portal P3c — the talent's own disputes. No cluster ⇒ a VALID empty list.
  listDisputes(): Promise<PortalDisputeListResponse> {
    return apiClient.get('/v1/portal/disputes');
  },

  // Portal P3c — one dispute reachable through the caller's chain (uniform 404
  // otherwise — no exists-vs-not-yours oracle).
  getDispute(id: string): Promise<PortalDisputeDetail> {
    return apiClient.get(`/v1/portal/disputes/${id}`);
  },

  // Portal P3c — append a talent statement while the dispute is open.
  respondDispute(
    id: string,
    statement: string,
    idempotencyKey: string,
  ): Promise<PortalDisputeMutation> {
    return apiClient.post(
      `/v1/portal/disputes/${id}/respond`,
      { statement },
      { headers: { 'Idempotency-Key': idempotencyKey } },
    );
  },

  // Portal P3c — withdraw an open dispute (terminal talent action; no body).
  withdrawDispute(
    id: string,
    idempotencyKey: string,
  ): Promise<PortalDisputeMutation> {
    return apiClient.post(
      `/v1/portal/disputes/${id}/withdraw`,
      {},
      { headers: { 'Idempotency-Key': idempotencyKey } },
    );
  },
};
