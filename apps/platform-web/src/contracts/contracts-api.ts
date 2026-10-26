import { ApiError, apiClient } from '@aramo/fe-foundation';

// CCP-B4 — the platform console's client for the enterprise contract records
// (GET /platform/commercial/contracts[/{id}], platform:subscription:read) and for
// the governed change requests that amend or end one (the CCP-A3 create + submit
// routes). The console never mutates a contract directly (PBD §5.3): a contract
// amendment is a SUBSCRIPTION_CHANGE request carrying `contract_amendment`, an
// end is a SUBSCRIPTION_END request carrying `contract_end`; both apply only
// after their approval chain is signed (CCP-A6).

export const CONTRACT_READ_SCOPE = 'platform:subscription:read';
/** The maker scope for contract amendment and end requests (commercial_ops, A1 §4.1). */
export const CONTRACT_REQUEST_SCOPE = 'platform:subscription:request';

export interface ContractPerson {
  user_id: string;
  display_name: string | null;
  email: string | null;
}

export interface ContractSummary {
  id: string;
  contract_ref: string;
  tenant: { id: string; name: string; slug: string | null };
  product_key: string;
  /** Derived server-side from the governed subscription row. */
  status: 'ACTIVE' | 'ENDED';
  subscription: {
    id: string;
    source: string;
    status: string;
    ended_at: string | null;
    commitment_start: string | null;
    commitment_end: string | null;
    plan: { key: string; name: string };
    plan_version: { id: string; version_number: number; status: string };
  };
  provenance: 'CHANGE_REQUEST' | 'MIGRATION';
  recorded_at: string;
}

export interface ContractDocument {
  name: string;
  sha256: string;
  byte_size: number | null;
  media_type: string | null;
  recorded_by: ContractPerson;
  recorded_at: string;
  amendment_sequence: number | null;
}

export interface ContractAmendment {
  sequence: number;
  kind: 'AMENDMENT' | 'END';
  summary: string;
  terms?: string[] | null;
  terms_withheld?: 'FINANCE_SCOPE_REQUIRED';
  document_count: number;
  evidence_ref: string | null;
  change_request_id: string;
  recorded_by: ContractPerson;
  recorded_at: string;
}

export interface ContractDetail extends ContractSummary {
  /**
   * CCP-R3-W (`wip/ccp-r3w`; W-2): for a caller without platform:billing:amount:read, `terms` and
   * `recorded_terms` are omitted and `terms_withheld` is set; every amendment then carries
   * `terms_withheld` and no `terms` (its `summary` stays visible).
   */
  terms?: string[];
  terms_withheld?: 'FINANCE_SCOPE_REQUIRED';
  recorded_terms?: string[];
  evidence_ref: string | null;
  recorded_by: ContractPerson;
  recorded_by_change_request_id: string;
  documents: ContractDocument[];
  amendments: ContractAmendment[];
  invoicing: { enabled: false; reason: 'enterprise_invoicing_choice_pending' };
}

export interface CreatedChangeRequest {
  request: { id: string; state: string };
  replayed: boolean;
}

function newKey(prefix: string): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const id = c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${id}`;
}

export const contractsApi = {
  list(): Promise<{ contracts: ContractSummary[] }> {
    return apiClient.get('/platform/commercial/contracts');
  },
  get(id: string): Promise<ContractDetail> {
    return apiClient.get(`/platform/commercial/contracts/${encodeURIComponent(id)}`);
  },
  /**
   * Record amendment… — a terms-only SUBSCRIPTION_CHANGE on the pinned version, submitted for
   * approval. Returns the submitted request.
   */
  async requestAmendment(c: ContractDetail, v: { amendment: string; reason: string; evidence: string }): Promise<{ id: string; state: string }> {
    const created = await apiClient.post<CreatedChangeRequest>('/platform/commercial/change-requests', {
      action_type: 'SUBSCRIPTION_CHANGE',
      tenant_id: c.tenant.id,
      product_key: c.product_key,
      payload: {
        subscription_id: c.subscription.id,
        plan_key: c.subscription.plan.key,
        plan_version_id: c.subscription.plan_version.id,
        contract_amendment: { contract_id: c.id, summary: v.amendment.trim(), documents: [], evidence_ref: v.evidence.trim() },
      },
      reason: v.reason.trim(),
      idempotency_key: newKey('ccp-b4-amend'),
    });
    return submit(created.request.id);
  },
  /** End contract… — a SUBSCRIPTION_END naming the contract, submitted for approval. */
  async requestEnd(c: ContractDetail, v: { reason: string; evidence: string }): Promise<{ id: string; state: string }> {
    const created = await apiClient.post<CreatedChangeRequest>('/platform/commercial/change-requests', {
      action_type: 'SUBSCRIPTION_END',
      tenant_id: c.tenant.id,
      product_key: c.product_key,
      payload: { subscription_id: c.subscription.id, contract_end: { contract_id: c.id, documents: [], evidence_ref: v.evidence.trim() } },
      reason: v.reason.trim(),
      idempotency_key: newKey('ccp-b4-end'),
    });
    return submit(created.request.id);
  },
};

async function submit(id: string): Promise<{ id: string; state: string }> {
  const out = await apiClient.post<{ request: { id: string; state: string } }>(`/platform/commercial/change-requests/${encodeURIComponent(id)}/submit`, {});
  return out.request;
}

/** A refused request → the operator copy (shown in the dialog's alert). */
export function contractRequestErrorText(e: unknown): string {
  if (!(e instanceof ApiError)) return 'The change request couldn’t be created. Try again.';
  const reason = e.details?.['reason'];
  if (reason === 'open_request_exists') return 'This tenant already has an open change request for this product. Other requests on this product wait until it closes.';
  if (reason === 'requester_scope_missing') return 'Contract changes need the Commercial ops role.';
  if (e.code === 'INSUFFICIENT_PERMISSIONS') return 'Contract changes need the Commercial ops role.';
  return typeof reason === 'string' && reason.length > 0 ? `${e.message} (${reason})` : e.message;
}
