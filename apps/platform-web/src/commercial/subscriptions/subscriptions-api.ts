import { apiClient } from '@aramo/fe-foundation';

// CCP-B3 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.3 row B3) — the typed platform-web
// client for the Subscriptions workbench and the Tenant › Commercial tab:
//   GET  /platform/commercial/subscriptions                         platform:subscription:read (CCP-B3 read)
//   GET  /platform/commercial/tenants/{id}/commercial               platform:subscription:read (CCP-B3 read)
//   GET  /platform/commercial/tenants/{id}/billing-status           platform:billing:read (CCP-C3; invoice link only)
//   POST /platform/commercial/change-requests (+ /{id}/submit)      CCP-A3: every tenant action
//   GET  /platform/commercial/change-requests/{id}                  CCP-A3 / A6-R `apply_actionable`
//   POST /platform/commercial/change-requests/{id}/apply            CCP-A6 / A7 governed apply (requester only)
//   POST /platform/commercial/change-requests/{id}/convert          CCP-C2 conversion apply (requester only)
//   GET  /platform/commercial/change-requests/{id}/conversion       CCP-C2 conversion state
// The console NEVER mutates commercial state itself (PLATFORM-UX-1 Amendment A1-2): every act is
// a change request, or the requester's governed apply of an approved one, and the server decides.
// No money is read for display (A1-4a): the billing-status read is used only for the provider's
// hosted invoice link (TD-C3-1). Request shapes match the platform-web → platform-admin Pact consumer.

export const SIGN_PRODUCT = 'sign';
export const PRODUCT_KEYS_SHOWN = ['sign', 'ats', 'portal', 'intelligence'] as const;
export type ProductKeyShown = (typeof PRODUCT_KEYS_SHOWN)[number];

export const PRODUCT_LABEL: Readonly<Record<string, string>> = {
  sign: 'Aramo Sign',
  ats: 'ATS',
  portal: 'Portal',
  intelligence: 'Intelligence',
};

export interface SubscriptionFacts {
  subscription_id: string;
  product_key: string;
  plan: { id: string; key: string; name: string; sales_model: string };
  plan_version: { id: string; version_number: number; status: string };
  /** MANUAL | SELF_SERVICE | DEVELOPMENT | FREE */
  source: string;
  /** TRIALING | ACTIVE | PAST_DUE | CANCELED | INCOMPLETE */
  status: string;
  started_at: string;
  ended_at: string | null;
  period_anchor: string;
  /** The monthly period containing `as_of` (end exclusive); null once ended. */
  current_period: { start: string; end: string } | null;
  current_period_end: string | null;
  grace_until: string | null;
  commitment_end: string | null;
  contract: { id: string; contract_ref: string } | null;
  provider_linked: boolean;
  open_flags: string[];
  active_extensions: { count: number; exception: boolean };
}

export interface WorkbenchRow extends SubscriptionFacts {
  tenant: { id: string; name: string | null; slug: string | null };
}

export interface Workbench {
  as_of: string;
  rows: WorkbenchRow[];
}

export interface EntitlementFacts {
  capability: string;
  state: 'ACTIVE' | 'REVOKED' | 'NONE';
  granted_source: string | null;
  granted_at: string | null;
  granted_by: string | null;
  change_request_id: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_change_request_id: string | null;
}

export interface HeldFlag {
  id: string;
  reason: string;
  provider: string;
  subscription_ref: string;
  intent_id: string | null;
  detected_at: string;
  conversion: { change_request_id: string; state: string; direction: string } | null;
}

export interface OpenRequestRef {
  id: string;
  action_type: string;
  kind: string;
  state: string;
  requested_by: string;
  created_at: string;
}

export interface ProductCommercial {
  product_key: string;
  /** True only for a product with a commercial catalog (v1: sign). */
  registered: boolean;
  entitlement: EntitlementFacts;
  subscription: SubscriptionFacts | null;
  flags: HeldFlag[];
  open_request: OpenRequestRef | null;
}

export interface TenantCommercial {
  as_of: string;
  tenant: { id: string; name: string; slug: string | null; kind: string };
  products: ProductCommercial[];
}

export interface ChangeRequestRef {
  id: string;
  action_type: string;
  kind: string;
  state: string;
  tenant_id: string | null;
  product_key: string | null;
  payload: Record<string, unknown>;
  requested_by: string;
  reason: string;
  created_at: string;
}

export interface ChangeRequestRead {
  request: ChangeRequestRef;
  /** CCP-A6-R (TD-B2-3, requester-only v1): true only when THIS caller may apply it now. */
  apply_actionable: boolean;
}

export interface ConversionRead {
  request: ChangeRequestRef;
  conversion: { direction: string; status: string; pending_provider: boolean };
}

export interface BillingInvoiceLink {
  availability: string;
  hosted_url: string | null;
}

/** The action types the tab creates (CCP-A3 closed set). */
export type TenantActionType = 'SUBSCRIPTION_CHANGE' | 'SUBSCRIPTION_END' | 'ENTITLEMENT_GRANT' | 'ENTITLEMENT_REVOKE' | 'CONVERSION';

export interface TenantRequestInput {
  readonly action_type: TenantActionType;
  readonly tenant_id: string;
  readonly payload: Record<string, unknown>;
  readonly reason: string;
  readonly evidence: string;
  /** false = Save as draft (no submit). */
  readonly submit: boolean;
  readonly idempotency_key: string;
}

/** A fresh idempotency key for one user act (8–200 chars of [A-Za-z0-9._:-]). */
export function newRequestKey(prefix: string): string {
  const rnd = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${rnd}`;
}

/** Merge train TD-MERGE-10 convention: the evidence travels in the reason. */
export function reasonWithEvidence(reason: string, evidence: string): string {
  return `${reason.trim()}\n\nEvidence: ${evidence.trim()}`;
}

const BASE = '/platform/commercial';
const CR = `${BASE}/change-requests`;

export const subscriptionsApi = {
  workbench(): Promise<Workbench> {
    return apiClient.get(`${BASE}/subscriptions`);
  },

  tenantCommercial(tenantId: string): Promise<TenantCommercial> {
    return apiClient.get(`${BASE}/tenants/${encodeURIComponent(tenantId)}/commercial`);
  },

  /** CCP-C3 (NOT DELIVERED): only the newest invoice's provider-hosted page is used; amounts are ignored. */
  async invoiceLink(tenantId: string): Promise<BillingInvoiceLink> {
    const out = await apiClient.get<{ availability: string; invoices?: { hosted_url: string | null }[] }>(
      `${BASE}/tenants/${encodeURIComponent(tenantId)}/billing-status?product_key=${SIGN_PRODUCT}&invoice_limit=1`,
    );
    return { availability: out.availability, hosted_url: out.invoices?.[0]?.hosted_url ?? null };
  },

  /** Create the change request; submit it for approval unless it is saved as a draft. */
  async request(input: TenantRequestInput): Promise<ChangeRequestRef> {
    const created = await apiClient.post<{ request: ChangeRequestRef; replayed: boolean }>(CR, {
      action_type: input.action_type,
      tenant_id: input.tenant_id,
      product_key: SIGN_PRODUCT,
      payload: input.payload,
      reason: reasonWithEvidence(input.reason, input.evidence),
      idempotency_key: input.idempotency_key,
    });
    if (!input.submit || created.request.state !== 'DRAFT') return created.request;
    const submitted = await apiClient.post<{ request: ChangeRequestRef }>(`${CR}/${encodeURIComponent(created.request.id)}/submit`);
    return submitted.request;
  },

  read(id: string): Promise<ChangeRequestRead> {
    return apiClient.get(`${CR}/${encodeURIComponent(id)}`);
  },

  conversion(id: string): Promise<ConversionRead> {
    return apiClient.get(`${CR}/${encodeURIComponent(id)}/conversion`);
  },

  /** The governed apply (A6 / A7); offered only when `apply_actionable` is true. */
  apply(id: string): Promise<{ request: ChangeRequestRef }> {
    return apiClient.post(`${CR}/${encodeURIComponent(id)}/apply`);
  },

  /** The governed conversion apply (C2); offered only when `apply_actionable` is true. */
  convert(id: string): Promise<{ request: ChangeRequestRef; conversion: { direction: string; status: string; pending_provider: boolean } }> {
    return apiClient.post(`${CR}/${encodeURIComponent(id)}/convert`);
  },
};
