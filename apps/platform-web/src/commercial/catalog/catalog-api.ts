import { apiClient } from '@aramo/fe-foundation';

// CCP-B2 (Program Build Directive §5.3 row B2) — typed client for the product and plan catalog
// (/platform/commercial/catalog, platform-admin) and for the two change-request calls the
// Catalog screen makes to request a publish or a retire (/platform/commercial/change-requests,
// CCP-A3). Request shapes are byte-aligned with the Pact consumer
// (pact/consumers/platform-web-consumer/src/platform-commercial-catalog.consumer.test.ts).
//
// The console NEVER publishes or retires: it creates a PLAN_VERSION_PUBLISH / PLAN_RETIRE
// change request and submits it (Finance → Owner); CCP-A6 applies an approved one.

export type PlanVersionStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';
export type CatalogActionType = 'PLAN_VERSION_PUBLISH' | 'PLAN_RETIRE';

export interface CatalogVersionTerms {
  /** Minor units (USD cents); null when contract-priced. */
  list_price_minor: number | null;
  currency: string | null;
  billing_interval: string | null;
  sales_model: string;
  contract_priced: boolean;
  envelopes_per_month: number | null;
  envelopes_unlimited: boolean;
  envelopes_present: boolean;
  /** Binary bytes. */
  storage_bytes: number | null;
  storage_unlimited: boolean;
  storage_present: boolean;
}

export interface CatalogOpenRequest {
  id: string;
  action_type: CatalogActionType;
  state: string;
  expires_at: string | null;
}

export interface CatalogVersion {
  id: string;
  plan_id: string;
  version_number: number;
  status: PlanVersionStatus;
  content_checksum: string;
  note: string | null;
  created_by: string;
  created_at: string;
  published_at: string | null;
  retired_at: string | null;
  terms: CatalogVersionTerms;
  pinned_subscriptions: number;
  open_requests: CatalogOpenRequest[];
}

export interface CatalogPlanSummary {
  id: string;
  key: string;
  product_key: string;
  name: string;
  status: string;
  sales_model: string;
  sellable: boolean;
  display_order: number;
}

export interface CatalogPlan extends CatalogPlanSummary {
  /** Newest first. */
  versions: CatalogVersion[];
}

export interface CatalogChainPreview {
  rule: string;
  step_role_keys: string[];
  policy_version_id: string;
  policy_version_number: number;
  approval_expiry_hours: number;
}

export interface Catalog {
  products: { product_key: string; plans: CatalogPlan[] }[];
  publish_chain: CatalogChainPreview | null;
}

export interface CatalogVersionDetail {
  version: CatalogVersion;
  plan: CatalogPlanSummary;
  content: Record<string, unknown>;
  pinned_tenants: { tenant_id: string; name: string }[];
}

export interface CatalogDraftEdits {
  list_price_minor?: number;
  envelopes_per_month?: number | null;
  storage_bytes?: number | null;
}

export interface CatalogChangeRequest {
  id: string;
  action_type: string;
  state: string;
  required_chain: { rule: string; steps: { step_index: number; role_key: string }[] };
  policy_version_id: string;
}

const CAT = '/platform/commercial/catalog';
const CR = '/platform/commercial/change-requests';

export const catalogApi = {
  // platform:catalog:read
  getCatalog(): Promise<Catalog> {
    return apiClient.get(CAT);
  },
  getVersion(versionId: string): Promise<CatalogVersionDetail> {
    return apiClient.get(`${CAT}/versions/${encodeURIComponent(versionId)}`);
  },
  // platform:catalog:draft
  createDraft(planId: string, fromVersionId: string): Promise<{ version: CatalogVersion }> {
    return apiClient.post(`${CAT}/plans/${encodeURIComponent(planId)}/drafts`, { from_version_id: fromVersionId });
  },
  updateDraft(versionId: string, expectedChecksum: string, edits: CatalogDraftEdits): Promise<{ version: CatalogVersion }> {
    return apiClient.patch(`${CAT}/versions/${encodeURIComponent(versionId)}`, { expected_content_checksum: expectedChecksum, ...edits });
  },
  // CCP-A3: the requester scope for these two actions is platform:catalog:draft (service-checked).
  async requestCatalogChange(input: {
    action_type: CatalogActionType;
    plan_version_id: string;
    reason: string;
    evidence: string;
    idempotency_key: string;
  }): Promise<CatalogChangeRequest> {
    const created = await apiClient.post<{ request: CatalogChangeRequest }>(CR, {
      action_type: input.action_type,
      payload: { plan_version_id: input.plan_version_id, evidence: input.evidence },
      reason: input.reason,
      idempotency_key: input.idempotency_key,
    });
    const submitted = await apiClient.post<{ request: CatalogChangeRequest }>(`${CR}/${encodeURIComponent(created.request.id)}/submit`);
    return submitted.request;
  },
  /**
   * Architect ruling TD-A6-13: an APPROVED (or APPLY_FAILED) catalog request is executed through
   * the governed apply route CCP-A6 added (POST /platform/commercial/change-requests/{id}/apply);
   * the publish/retire apply itself is CCP-B2-backend. The server decides who may apply and
   * reports the resulting state; the console only renders it. Coded against that contract — the
   * B2 worktree base predates A6, so it is mocked in the specs and wired by the lead at merge.
   */
  async applyChangeRequest(id: string): Promise<CatalogChangeRequest> {
    const out = await apiClient.post<{ request: CatalogChangeRequest }>(`${CR}/${encodeURIComponent(id)}/apply`);
    return out.request;
  },
};
