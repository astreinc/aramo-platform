import { apiClient } from '@aramo/fe-foundation';

// CCP-B6 — the typed platform-web client for the support-extension workflow (CCP-A8 backend):
//   GET  /platform/commercial/support-extensions?tenant_id=&product_key=   platform:subscription:read
//        the overlays (with the context recorded at apply), the tenant's open base rows and the
//        ACTIVE policy clause (CCP-B6 additive read)
//   POST /platform/commercial/support-extensions                            platform:subscription:support
//        in bounds → applied at once as a bounded EXCEPTION (zero approvals, audited);
//        a limit breach → escalated to a Finance request (Q7), nothing applies; not eligible
//        (CCP-R3) → refused 409 support_extension_ineligible, nothing applies or escalates
//   POST /platform/commercial/change-requests (+ /{id}/submit)              removal: SUPPORT_EXTENSION,
//        payload { operation: REMOVE, support_extension_id } (TD-A8-5; Finance approves)
//   GET  /platform/commercial/change-requests[/{id}]                        the open escalation / removal
//   POST /platform/commercial/change-requests/{id}/apply                    the requester applies an
//        approved request (TD-B2-3; offered only when `apply_actionable`)
// The console never mutates commercial state itself (PLATFORM-UX-1 Amendment A1-2): every act is
// one of these governed calls, and the server decides. Request shapes match the platform-web →
// platform-admin Pact consumer.

export const SUPPORT_PRODUCT_KEY = 'sign';

export interface ExtensionClause {
  support_extension_max_days: number;
  support_extension_frequency_window_days: number;
  support_extension_cumulative_max_days: number;
  support_extension_cumulative_window_days: number;
}

export interface SupportExtension {
  id: string;
  tenant_id: string;
  product_key: string;
  subscription_id: string;
  change_request_id: string;
  is_exception: boolean;
  days: number;
  grace_until_at_apply: string | null;
  base_until: string;
  extends_until: string;
  policy_version_id: string;
  applied_by: string;
  applied_at: string;
  removed_at: string | null;
  removed_by: string | null;
  remove_change_request_id: string | null;
  active?: boolean;
  context?: {
    policy_version_number: number | null;
    clause: Partial<ExtensionClause> | null;
    counters: Partial<ExtensionCounters> | null;
    roles_at_apply: string[];
  };
}

export interface ExtensionCounters {
  requested_days: number;
  extensions_in_frequency_window: number;
  cumulative_days_before: number;
  cumulative_days_after: number;
}

export interface SupportSubscription {
  id: string;
  product_key: string;
  source: string;
  status: string;
  grace_until: string | null;
  current_period_end: string | null;
}

export interface SupportPolicy {
  version_id: string;
  version_number: number;
  clause: Partial<ExtensionClause>;
  approval_expiry_hours: number;
}

export interface SupportExtensionList {
  extensions: SupportExtension[];
  subscriptions: SupportSubscription[];
  policy: SupportPolicy | null;
}

export interface SupportDecision {
  /** CCP-R3: always true on an outcome (an ineligible request is refused, 409 support_extension_ineligible). */
  eligible?: boolean;
  within_bounds: boolean;
  breaches: string[];
  eligibility: string[];
  counters: ExtensionCounters;
  clause: Record<string, number>;
}

/** The change request (A3 DTO); `apply_actionable` arrives with A6-R on the detail read (TD-B2-3). */
export interface SupportChangeRequest {
  id: string;
  action_type: string;
  kind: string;
  state: string;
  tenant_id: string | null;
  product_key: string | null;
  payload: Record<string, unknown>;
  required_chain: { rule: string; basis: Record<string, unknown>; steps: { step_index: number; role_key: string; scope_keys: string[] }[] };
  policy_version_id: string;
  requested_by: string;
  reason: string;
  created_at: string;
  submitted_at: string | null;
  expires_at: string | null;
  approved_at: string | null;
}

export interface SupportChangeRequestDetail {
  request: SupportChangeRequest;
  /** CCP-A6-R (TD-B2-3): true only for the requester of an approved request the governed apply covers. */
  apply_actionable?: boolean;
}

export interface SupportExtensionOutcome {
  outcome: 'APPLIED' | 'ESCALATED';
  replayed: boolean;
  request: SupportChangeRequest;
  extension: SupportExtension | null;
  decision: SupportDecision | null;
}

/** The change-request states that hold the tenant × product slot (Q14). */
export const OPEN_REQUEST_STATES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'APPLYING', 'APPLY_FAILED'] as const;

/** A fresh idempotency key for one user act (8–200 chars of [A-Za-z0-9._:-]). */
export function newIdempotencyKey(prefix: string): string {
  const rnd = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${rnd}`;
}

const SE = '/platform/commercial/support-extensions';
const CR = '/platform/commercial/change-requests';

export const supportExtensionApi = {
  list(tenantId: string): Promise<SupportExtensionList> {
    return apiClient.get(`${SE}?tenant_id=${encodeURIComponent(tenantId)}&product_key=${SUPPORT_PRODUCT_KEY}`);
  },

  request(body: { tenant_id: string; subscription_id: string; requested_days: number; reason: string; idempotency_key: string }): Promise<SupportExtensionOutcome> {
    return apiClient.post(SE, { ...body, product_key: SUPPORT_PRODUCT_KEY });
  },

  /** The open SUPPORT_EXTENSION requests of one tenant (the list route has no tenant filter). */
  async openRequests(tenantId: string): Promise<SupportChangeRequest[]> {
    const page: { requests: SupportChangeRequest[] } = await apiClient.get(`${CR}?limit=200`);
    return page.requests.filter(
      (r) => r.action_type === 'SUPPORT_EXTENSION' && r.tenant_id === tenantId && r.product_key === SUPPORT_PRODUCT_KEY && (OPEN_REQUEST_STATES as readonly string[]).includes(r.state),
    );
  },

  detail(id: string): Promise<SupportChangeRequestDetail> {
    return apiClient.get(`${CR}/${encodeURIComponent(id)}`);
  },

  /** Removal = a SUPPORT_EXTENSION change request with operation REMOVE, then submitted for Finance. */
  async requestRemoval(body: { tenant_id: string; support_extension_id: string; reason: string; idempotency_key: string }): Promise<SupportChangeRequest> {
    const created: { request: SupportChangeRequest } = await apiClient.post(CR, {
      action_type: 'SUPPORT_EXTENSION',
      tenant_id: body.tenant_id,
      product_key: SUPPORT_PRODUCT_KEY,
      payload: { operation: 'REMOVE', support_extension_id: body.support_extension_id },
      reason: body.reason,
      idempotency_key: body.idempotency_key,
    });
    if (created.request.state !== 'DRAFT') return created.request; // an idempotent replay of a submitted one
    const submitted: { request: SupportChangeRequest } = await apiClient.post(`${CR}/${encodeURIComponent(created.request.id)}/submit`);
    return submitted.request;
  },

  apply(id: string): Promise<{ request: SupportChangeRequest }> {
    return apiClient.post(`${CR}/${encodeURIComponent(id)}/apply`);
  },
};
