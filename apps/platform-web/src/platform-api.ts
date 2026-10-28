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
  // PLATFORM-UX-1 B-1b (directive R-7) — the subdomain label, or null.
  slug: string | null;
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

// Domain-Enforcement P3 — the operator view of a tenant's email-domain claim
// (GET /platform/tenants/:id/domain and every domain action's response). Reads
// and writes all need platform:tenant:lifecycle:manage.
export type DomainClaimState = 'PROVISIONAL' | 'AUTHORITATIVE' | 'LAPSED' | 'RELEASED';

export interface TenantDomainClaim {
  domain: string;
  claim: DomainClaimState | string;
  expires_at: string | null;
  reason: string | null;
  exception: boolean;
}

export interface TenantDomainException {
  id: string;
  domain: string;
  justification: string;
  evidence_ref: string;
  granted_by_user_id: string;
  granted_at: string;
  revoked_by_user_id: string | null;
  revoked_at: string | null;
}

export interface TenantDomain {
  tenant_id: string;
  domain_claim: TenantDomainClaim | null;
  exceptions: TenantDomainException[];
}

// POST /platform/tenants/:id/invitations — invite a user into a tenant.
export interface InviteTenantUserResult {
  tenant_id: string;
  user_id: string;
  membership_id: string;
  role_keys: string[];
  status: 'invitation_sent' | 'roles_updated';
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
// ATI-SEP-1 T9 — `intelligence` (Talent Intelligence) is provisionable; default OFF.
const CAPABILITIES = ['core', 'ats', 'portal', 'sourcing', 'sign', 'intelligence'] as const;
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


// Aramo Sign Personal (Free) — the operator's Personal review queue and pilot
// invites (Aramo-Sign-Personal-Free-Launch-Directive-v1_1 §6.5, §10). Every route
// is guarded by platform:tenant:lifecycle:manage; the backend is authoritative.
export type PersonalRiskState = 'clear' | 'review' | 'restricted' | 'closed';

export interface PersonalRiskSignal {
  key: string;
  points: number;
  detail?: string | null;
}

export interface PersonalReviewItem {
  tenant_id: string;
  tenant_name: string;
  owner_email: string | null;
  state: PersonalRiskState;
  reason: string | null;
  // A review still owed while a temporary restriction is in force.
  review_pending?: boolean;
  risk_points: number | null;
  signals: PersonalRiskSignal[];
  phone_verified_at: string | null;
  restricted_until: string | null;
  report_count?: number | null;
  // Whether a phone step is outstanding (phone verification not yet satisfied).
  step_up_required?: boolean;
  // 'review' = an operator's review lifted the phone step while SMS was unavailable.
  step_up_cleared_by?: string | null;
  // True when clearing this review would also lift the phone step (SMS unavailable).
  review_clears_phone_step?: boolean;
  // The signup's GeoLite2 evidence (a risk signal, not proof of location); country null = unknown.
  geo?: { country: string | null; looked_up_at: string; db_version: string | null } | null;
  created_at: string;
  updated_at: string;
}

export type PersonalReviewAction = 'clear-review' | 'restrict' | 'reinstate' | 'close';

export type AbuseReportOutcome = 'OPEN' | 'CONFIRMED' | 'FALSE_REPORT' | 'DISMISSED';

export interface PersonalAbuseReport {
  id: string;
  envelope_id: string;
  reason: string | null;
  note: string | null;
  reporter_domain: string;
  weight: number;
  triggered_restriction: boolean;
  outcome: AbuseReportOutcome;
  outcome_reason: string | null;
  decided_at: string | null;
  created_at: string;
}

/** M-A7 §5.2 — one report in the operators' queue, with the sender it is about. */
export interface SignAbuseQueueItem extends PersonalAbuseReport {
  tenant_id: string;
  sender_kind: string | null;
  sender_name: string | null;
}

export interface PersonalInvite {
  code: string;
  email: string;
  expires_at: string | null;
}

// PLATFORM-UX-1 B-1a (directive R-6) — the signed-in operator, caller only
// (GET /platform/me). The shared Session type carries no name or email.
export interface PlatformMe {
  user_id: string;
  email: string;
  display_name: string | null;
  tenant_id: string;
  tenant_name: string;
  role_keys: string[];
}

export const platformApi = {
  // PLATFORM-UX-1 B-1a — the signed-in operator's identity (caller only).
  getMe(): Promise<PlatformMe> {
    return apiClient.get('/platform/me');
  },

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
    // IC-2 PR-4 — optional subdomain label; validated server-side (deriveSlugOrThrow).
    slug?: string;
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
    body: { retentionPolicyCode: string; closeAt: string; reasonCode?: string; reasonText?: string },
  ): Promise<LifecycleActionResult> {
    return apiClient.post(`/platform/tenants/${id}/start-offboarding`, body);
  },

  // Aramo Sign Personal (Free) — review queue, review actions and pilot invites.
  listPersonalReview(): Promise<{ items: PersonalReviewItem[]; phone_verification_available?: boolean }> {
    return apiClient.get('/platform/personal-review');
  },

  personalReviewAction(
    id: string,
    action: PersonalReviewAction,
    body: { reason: string; until?: string },
  ): Promise<unknown> {
    return apiClient.post(`/platform/tenants/${encodeURIComponent(id)}/personal/${action}`, body);
  },

  listPersonalReports(tenantId: string): Promise<{ items: PersonalAbuseReport[] }> {
    return apiClient.get(`/platform/tenants/${encodeURIComponent(tenantId)}/personal/reports`);
  },

  // M-A7 §5.2 — the abuse-report queue across every Aramo Sign sender.
  listSignAbuseReports(outcome?: AbuseReportOutcome): Promise<{ items: SignAbuseQueueItem[] }> {
    return apiClient.get(`/platform/sign-abuse-reports${outcome !== undefined ? `?outcome=${encodeURIComponent(outcome)}` : ''}`);
  },

  decidePersonalReport(reportId: string, body: { outcome: Exclude<AbuseReportOutcome, 'OPEN'>; reason: string }): Promise<PersonalAbuseReport> {
    return apiClient.post(`/platform/personal-reports/${encodeURIComponent(reportId)}/decide`, body);
  },

  issuePersonalInvite(body: { email: string }): Promise<PersonalInvite> {
    return apiClient.post('/platform/personal-invites', body);
  },

  // PLATFORM-UX-1 F-5 — invite a user into a tenant (platform:tenant:provision).
  inviteTenantUser(
    id: string,
    body: { email: string; role_keys: string[]; display_name?: string },
  ): Promise<InviteTenantUserResult> {
    return apiClient.post(`/platform/tenants/${encodeURIComponent(id)}/invitations`, body);
  },

  // PLATFORM-UX-1 F-5 — the tenant's domain claim and its four operator actions
  // (platform:tenant:lifecycle:manage, reads included).
  getTenantDomain(id: string): Promise<TenantDomain> {
    return apiClient.get(`/platform/tenants/${encodeURIComponent(id)}/domain`);
  },

  promoteTenantDomain(id: string, body: { evidence_ref: string }): Promise<TenantDomain> {
    return apiClient.post(`/platform/tenants/${encodeURIComponent(id)}/domain/promote`, body);
  },

  releaseTenantDomain(id: string, body: { reason: string }): Promise<TenantDomain> {
    return apiClient.post(`/platform/tenants/${encodeURIComponent(id)}/domain/release`, body);
  },

  grantTenantDomainException(id: string, body: { justification: string; evidence_ref: string }): Promise<TenantDomain> {
    return apiClient.post(`/platform/tenants/${encodeURIComponent(id)}/domain/exception`, body);
  },

  revokeTenantDomainException(id: string): Promise<TenantDomain> {
    return apiClient.delete(`/platform/tenants/${encodeURIComponent(id)}/domain/exception`);
  },

  close(
    id: string,
    body: { reasonCode: string; reasonText?: string },
  ): Promise<LifecycleActionResult> {
    return apiClient.post(`/platform/tenants/${id}/close`, body);
  },
};
