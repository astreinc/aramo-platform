import { apiClient } from '@aramo/fe-foundation';

// Typed client for the platform-admin surface (/platform/*), proxied to
// 127.0.0.1:3002 in dev. platform-web talks ONLY to /auth + /platform (A4) — no
// /v1. All calls ride the shared HttpOnly session cookie via apiClient.

export interface PlatformTenantSummary {
  id: string;
  name: string;
  // IC-4 PR-9 — BUSINESS | PERSONAL.
  kind: string;
  slug: string | null;
  status: string;
  status_reason_code: string | null;
  status_changed_at: string;
  is_active: boolean;
  created_at: string;
  activated_at: string | null;
  suspended_at: string | null;
}

// The detail read (GET /platform/tenants/:id) returns the identity TenantDto —
// deliberately thinner than the list row (see the detail view for what the
// Overview can render from it).
export interface PlatformTenantDetail {
  id: string;
  name: string;
  // IC-4 PR-9 — BUSINESS | PERSONAL.
  kind: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  identity_provider: string | null;
  status: string;
}

export interface PlatformAuditEvent {
  event_type: string;
  created_at: string;
  actor_type: string;
  actor_id: string | null;
  event_payload: Record<string, unknown>;
}

// Inc-3 PR-3.8 (A/C) — the operator dashboard summary (GET /platform/dashboard).
// Counts / ages / statuses / events only (R10) — no numeric rating of a tenant.
export interface PlatformDashboardStatusCount {
  status: string;
  count: number;
}

export interface PlatformDashboardOnboardingRow {
  tenant_id: string;
  name: string;
  created_at: string;
  invited: boolean;
}

export interface PlatformDashboardActivityRow {
  event_type: string;
  tenant_id: string | null;
  tenant_name: string | null;
  actor_type: string;
  reason_code: string | null;
  created_at: string;
}

export interface PlatformDashboard {
  status_counts: PlatformDashboardStatusCount[];
  onboarding: PlatformDashboardOnboardingRow[];
  recent_activity: PlatformDashboardActivityRow[];
}

export interface ProvisionTenantResult {
  tenant_id: string;
  tenant_name: string;
  // IC-4 PR-9 — BUSINESS | PERSONAL.
  tenant_kind: string;
  owner_user_id: string;
  owner_email: string;
  membership_id: string;
  capabilities: string[];
  invitation_sent: boolean;
}

export interface LifecycleActionResult {
  tenant_id: string;
  from: string;
  to: string;
  status: string;
  changed: boolean;
}

// IC-3 PR-8 — mirrors libs/entitlement CAPABILITY_VALUES (the backend-authoritative
// closed set; the DTO + EntitlementRepository decide, this list only OFFERS). `sign`
// lets an operator provision a Sign-only ([core, esign]) or ATS + Sign tenant.
const CAPABILITIES = ['core', 'ats', 'portal', 'sourcing', 'sign'] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const ALL_CAPABILITIES: readonly Capability[] = CAPABILITIES;

// IC-4 PR-9 — mirrors libs/identity TENANT_KINDS (backend-authoritative). A
// PERSONAL tenant's capability set is CLOSED to [core, esign] server-side; the
// form only pre-selects it.
export const TENANT_KINDS = ['BUSINESS', 'PERSONAL'] as const;
export type TenantKind = (typeof TENANT_KINDS)[number];
export const PERSONAL_TENANT_CAPABILITIES: readonly Capability[] = ['core', 'sign'];

// Aramo Sign launch — the operator's read-only view of a tenant's Sign account.
export interface PlatformTenantSign {
  tenant_id: string;
  tenant_kind: string;
  capabilities: string[];
  sign_entitled: boolean;
  subscription: {
    plan_key: string;
    plan_name: string;
    source: string;
    status: string;
    sending: boolean;
    started_at: string;
    ended_at: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    grace_until: string | null;
    billing_managed: boolean;
    commitment_end?: string | null;
    cancel_requested_within_commitment?: boolean;
    eligibility_state?: string | null;
  } | null;
  allowance: { subscribed: true; limit: number | null; used: number; remaining: number | null; period_start: string; period_end: string } | { subscribed: false; state?: string };
  storage?: { capacity_key: string; limit: number | null; unlimited: boolean; used: number } | null;
  billing_available: boolean;
  billing_events: { event_type: string; outcome: string; detail: string | null; event_created_at: string; received_at: string }[];
}

export const platformApi = {
  // Inc-3 PR-3.8 — the operator dashboard summary (default screen).
  getDashboard(): Promise<PlatformDashboard> {
    return apiClient.get('/platform/dashboard');
  },

  listTenants(params?: { status?: string; q?: string }): Promise<{
    tenants: PlatformTenantSummary[];
  }> {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.q) qs.set('q', params.q);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return apiClient.get(`/platform/tenants${suffix}`);
  },

  getTenant(id: string): Promise<{ tenant: PlatformTenantDetail }> {
    return apiClient.get(`/platform/tenants/${id}`);
  },

  getTenantAudit(id: string): Promise<{ events: PlatformAuditEvent[] }> {
    return apiClient.get(`/platform/tenants/${id}/audit`);
  },

  getTenantSign(id: string): Promise<PlatformTenantSign> {
    return apiClient.get(`/platform/tenants/${id}/sign`);
  },

  provisionTenant(body: {
    name: string;
    owner_email: string;
    owner_display_name?: string;
    capabilities?: string[];
    // Inc-3 PR-3.4 — omit/true invites the owner now; false defers the invite
    // (create-now-invite-later). Response carries invitation_sent.
    invite_owner?: boolean;
    // IC-4 PR-9 — BUSINESS (default) | PERSONAL; the backend DTO + service are
    // the authority (closed TENANT_KINDS, personal capability set, owner role).
    kind?: TenantKind;
  }): Promise<ProvisionTenantResult> {
    return apiClient.post('/platform/tenants', body);
  },

  resendOwnerInvite(id: string): Promise<{
    tenant_id: string;
    owner_user_id: string;
    owner_email: string;
    resent: true;
  }> {
    return apiClient.post(`/platform/tenants/${id}/resend-owner-invite`);
  },

  suspend(
    id: string,
    body: { reasonCode: string; reasonText: string },
  ): Promise<LifecycleActionResult> {
    return apiClient.post(`/platform/tenants/${id}/suspend`, body);
  },

  reactivate(
    id: string,
    body: { reasonCode: string },
  ): Promise<LifecycleActionResult> {
    return apiClient.post(`/platform/tenants/${id}/reactivate`, body);
  },

  startOffboarding(
    id: string,
    body: { retentionPolicyCode: string; closeAt: string; reasonCode?: string },
  ): Promise<LifecycleActionResult> {
    return apiClient.post(`/platform/tenants/${id}/start-offboarding`, body);
  },

  close(
    id: string,
    body: { reasonCode: string; reasonText?: string },
  ): Promise<LifecycleActionResult> {
    return apiClient.post(`/platform/tenants/${id}/close`, body);
  },
};
