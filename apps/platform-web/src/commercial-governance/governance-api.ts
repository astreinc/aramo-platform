import { apiClient } from '@aramo/fe-foundation';

// CCP-B5 — the typed client for the commercial governance routes the console calls
// (platform-admin; consumer `platform`). Every change these screens start is a governed
// change request on POST /platform/commercial/change-requests (PLATFORM-UX-1 Amendment
// A1-2): a policy activation is a POLICY_ACTIVATE request, a role change one ROLE_GRANT /
// ROLE_REVOKE request per role toggled. There is no direct role grant and no direct
// policy activation here (PBD §5.3 B5 "Out: any direct role grant").
//
// The request shapes are byte-aligned with the platform-web → platform-admin Pact consumer
// (pact/consumers/platform-web-consumer/src/platform-governance.consumer.test.ts).

export interface PolicyContent {
  format_version: number;
  currency: string;
  discount_escalation_threshold_bps: number;
  credit_escalation_threshold_minor: number;
  support_extension_max_days: number;
  support_extension_frequency_window_days: number;
  support_extension_cumulative_max_days: number;
  support_extension_cumulative_window_days: number;
  approval_expiry_hours: number;
  past_due_grace_days: number;
  /** CCP-FIX1 (Charter Amendment A1 AD-1): optional; present only when the version declares an apply deadline. */
  apply_expiry_hours?: number;
}
export type PolicyEditableKey = Exclude<keyof PolicyContent, 'format_version' | 'currency'>;

export interface PolicyVersion {
  id: string;
  version_number: number;
  status: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  content: PolicyContent | null;
  content_checksum: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
  activated_by: string | null;
  activated_at: string | null;
  retired_at: string | null;
  /** The open activation request targeting this version; `apply_actionable` = the caller may apply it now (CCP-B5-R). */
  open_request: { id: string; state: string; apply_actionable: boolean } | null;
  /** CCP-B5-R — the most recent activation request targeting this version, in any state. */
  latest_request: { id: string; state: string; applied_at: string | null } | null;
}

export interface PolicyList {
  versions: PolicyVersion[];
  active_version_id: string | null;
  open_request: { id: string; state: string; policy_version_id: string } | null;
  caller: { can_author: boolean; can_request_activation: boolean };
}

export interface RosterOperator {
  user_id: string;
  email: string | null;
  display_name: string | null;
  role_keys: string[];
  commercial_role_keys: string[];
  attested: boolean;
  is_last_owner: boolean;
  pending_role_requests: {
    id: string;
    action_type: 'ROLE_GRANT' | 'ROLE_REVOKE';
    role_key: string;
    state: string;
  }[];
}

export type ChainKey =
  | 'ABOVE_THRESHOLD'
  | 'BELOW_THRESHOLD'
  | 'CATALOG_PUBLISH'
  | 'ROLE_CHANGE'
  | 'POLICY_CHANGE';
export interface ChainState {
  key: ChainKey;
  rule: string;
  maker_roles: string[];
  step_roles: string[];
  fulfillable: boolean;
  missing: 'maker' | 'steps' | null;
  unfillable_steps: number[];
}
export interface Roster {
  operators: RosterOperator[];
  chains: ChainState[];
  all_fulfillable: boolean;
}

export interface AuditEvent {
  id: string;
  created_at: string;
  actor_id: string | null;
  actor_type: string;
  actor_role_keys: string[];
  event_type: string;
  is_exception: boolean;
  tenant_id: string | null;
  subject: string;
  change_request_id: string | null;
  policy_version_id: string;
  payload: Record<string, unknown>;
  correlation_id: string;
}

export interface AuditFilters {
  actor_id?: string;
  event_type?: string;
  tenant_id?: string;
  exception_only?: boolean;
  change_request_id?: string;
  product_key?: string;
}

export interface AuditExport {
  export_id: string;
  exported_at: string;
  row_count: number;
  filename: string;
  content_type: 'text/csv';
  csv: string;
  csv_sha256: string;
}

export interface ChangeRequestRef {
  id: string;
  action_type: string;
  state: string;
  policy_version_id: string;
  required_chain: { rule: string; steps: { step_index: number; role_key: string }[] };
}

const CR = '/platform/commercial/change-requests';

function auditQuery(f: AuditFilters & { limit?: number; cursor?: string }): string {
  const q = new URLSearchParams();
  if (f.actor_id) q.set('actor_id', f.actor_id);
  if (f.event_type) q.set('event_type', f.event_type);
  if (f.tenant_id) q.set('tenant_id', f.tenant_id);
  if (f.exception_only) q.set('exception_only', 'true');
  if (f.change_request_id) q.set('change_request_id', f.change_request_id);
  if (f.product_key) q.set('product_key', f.product_key);
  if (f.limit !== undefined) q.set('limit', String(f.limit));
  if (f.cursor) q.set('cursor', f.cursor);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** A request-scoped idempotency key (A3: 8–200 of [A-Za-z0-9._:-]). */
export function idempotencyKey(prefix: string): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${rnd}`;
}

export const governanceApi = {
  listPolicyVersions(): Promise<PolicyList> {
    return apiClient.get('/platform/commercial/policy-versions');
  },
  createPolicyDraft(body: {
    source_version_id: string;
    note?: string;
  }): Promise<{ version: PolicyVersion }> {
    return apiClient.post('/platform/commercial/policy-versions', body);
  },
  updatePolicyDraft(
    id: string,
    body: { content?: Partial<Pick<PolicyContent, PolicyEditableKey>>; note?: string },
  ): Promise<{ version: PolicyVersion }> {
    return apiClient.patch(`/platform/commercial/policy-versions/${id}`, body);
  },
  listOperators(): Promise<Roster> {
    return apiClient.get('/platform/commercial/operators');
  },
  listAuditEvents(
    f: AuditFilters & { limit?: number; cursor?: string },
  ): Promise<{ events: AuditEvent[]; next_cursor: string | null }> {
    return apiClient.get(`/platform/commercial/audit-events${auditQuery(f)}`);
  },
  exportAudit(f: AuditFilters): Promise<AuditExport> {
    return apiClient.post('/platform/commercial/audit-events/export', f);
  },
  /** CCP-B5-R — the requester applies an approved (or failed) activation request. */
  applyChange(id: string): Promise<{ request: { id: string; state: string; applied_at: string | null } }> {
    return apiClient.post(`${CR}/${id}/apply`);
  },
  /** A governed change request (created as DRAFT), then submitted for approval. */
  async requestChange(body: {
    action_type: 'POLICY_ACTIVATE' | 'ROLE_GRANT' | 'ROLE_REVOKE';
    payload: Record<string, unknown>;
    reason: string;
    idempotency_key: string;
  }): Promise<ChangeRequestRef> {
    const created = await apiClient.post<{ request: ChangeRequestRef }>(CR, body);
    const submitted = await apiClient.post<{ request: ChangeRequestRef }>(
      `${CR}/${created.request.id}/submit`,
    );
    return submitted.request;
  },
};
