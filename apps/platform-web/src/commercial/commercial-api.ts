import { apiClient } from '@aramo/fe-foundation';

// CCP-B1 — the typed platform-web client for the CCP-A3 / CCP-A9 change-request
// routes (platform-admin `platform/commercial/change-requests`, gate
// `platform:approval:read`). Every commercial act the console starts is one of
// these calls: the console never mutates commercial state itself (PLATFORM-UX-1
// Amendment A1, A1-2). The request shapes are byte-aligned with the platform-web →
// platform-admin Pact consumer (pact/consumers/platform-web-consumer, CCP-A10 §5
// item 6).

export const CHANGE_REQUEST_STATES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'APPLYING',
  'APPLIED',
  'APPLY_FAILED',
  'REJECTED',
  'EXPIRED',
  'WITHDRAWN',
] as const;
export type ChangeRequestState = (typeof CHANGE_REQUEST_STATES)[number];

/** The 7 approval refusals, in the engine's precedence order (commercial-approval-eligibility.ts). */
export const APPROVAL_REFUSALS = [
  'NOT_PENDING',
  'EXPIRED',
  'NOT_HUMAN',
  'SELF_APPROVAL',
  'USER_ALREADY_APPROVED',
  'STEP_SCOPE_MISSING',
  'OUT_OF_ORDER',
] as const;
export type ApprovalRefusal = (typeof APPROVAL_REFUSALS)[number];

export interface ChainStep {
  step_index: number;
  role_key: string;
  scope_keys: string[];
}

export interface ChangeRequest {
  id: string;
  action_type: string;
  kind: string;
  state: string;
  tenant_id: string | null;
  product_key: string | null;
  payload: Record<string, unknown>;
  payload_checksum: string;
  required_chain: { rule: string; basis: Record<string, unknown>; steps: ChainStep[] };
  policy_version_id: string;
  policy_checksum: string;
  requested_by: string;
  reason: string;
  created_at: string;
  submitted_at: string | null;
  expires_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  rejected_by: string | null;
  rejection_reason: string | null;
  withdrawn_at: string | null;
  expired_at: string | null;
  /** CCP-A9: set when the request was applied. Absent on older responses. */
  applied_at?: string | null;
}

export interface Approval {
  id: string;
  step_index: number;
  approver_user_id: string;
  step_role_key: string;
  step_scope_keys: string[];
  approver_role_keys: string[];
  comment: string | null;
  created_at: string;
}

export interface StepVerdict {
  eligible: boolean;
  refusal: string | null;
}

export interface ChangeRequestDetail {
  request: ChangeRequest;
  approvals: Approval[];
  is_expired: boolean;
  /** null when the chain is not evaluated (not pending). */
  chain_satisfiable: boolean | null;
  /** CCP-A6-R (TD-B2-3, requester-only v1): true only when THIS caller may apply it now. */
  apply_actionable: boolean;
  steps: Array<{
    step_index: number;
    role_key: string;
    scope_keys: string[];
    status: 'APPROVED' | 'NEXT' | 'WAITING';
    approval_id: string | null;
    /** The caller's verdict for this step; null once the step is approved. */
    caller: StepVerdict | null;
  }>;
}

/** CCP-A9: the role-change apply that follows the completing approval. */
export interface RoleChangeApply {
  applied: boolean;
  reason: string | null;
  detail: Record<string, unknown>;
}

export interface ApproveResult {
  request: ChangeRequest;
  approval: Approval;
  apply?: RoleChangeApply | null;
}

/** The page size the inbox reads (the route's maximum). */
export const LIST_LIMIT = 200;

const BASE = '/platform/commercial/change-requests';

export const commercialApi = {
  /** Every request (one page of up to 200), or the ones the caller can sign now. */
  listChangeRequests(params: { eligibleForMe?: boolean } = {}): Promise<{ requests: ChangeRequest[]; next_cursor: string | null }> {
    const qs = new URLSearchParams();
    if (params.eligibleForMe === true) qs.set('eligible_for_me', 'true');
    qs.set('limit', String(LIST_LIMIT));
    return apiClient.get(`${BASE}?${qs.toString()}`);
  },

  getChangeRequest(id: string): Promise<ChangeRequestDetail> {
    return apiClient.get(`${BASE}/${encodeURIComponent(id)}`);
  },

  submit(id: string): Promise<{ request: ChangeRequest }> {
    return apiClient.post(`${BASE}/${encodeURIComponent(id)}/submit`);
  },

  withdraw(id: string): Promise<{ request: ChangeRequest }> {
    return apiClient.post(`${BASE}/${encodeURIComponent(id)}/withdraw`);
  },

  /** Signs `step_index` (the engine refuses a stale or wrong step: OUT_OF_ORDER). */
  approve(id: string, stepIndex: number): Promise<ApproveResult> {
    return apiClient.post(`${BASE}/${encodeURIComponent(id)}/approvals`, { step_index: stepIndex });
  },

  reject(id: string, reason: string): Promise<{ request: ChangeRequest }> {
    return apiClient.post(`${BASE}/${encodeURIComponent(id)}/reject`, { reason });
  },
};
