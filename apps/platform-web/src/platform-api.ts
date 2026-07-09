import { apiClient } from '@aramo/fe-foundation';

// Typed client for the platform-admin surface (/platform/*), proxied to
// 127.0.0.1:3002 in dev. platform-web talks ONLY to /auth + /platform (A4) — no
// /v1. All calls ride the shared HttpOnly session cookie via apiClient.

export interface PlatformTenantSummary {
  id: string;
  name: string;
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

export interface ProvisionTenantResult {
  tenant_id: string;
  tenant_name: string;
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

const CAPABILITIES = ['core', 'ats', 'portal', 'sourcing'] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const ALL_CAPABILITIES: readonly Capability[] = CAPABILITIES;

export const platformApi = {
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

  provisionTenant(body: {
    name: string;
    owner_email: string;
    owner_display_name?: string;
    capabilities?: string[];
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
