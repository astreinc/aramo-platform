import { apiClient } from '@aramo/fe-foundation';

// CCP-UI-V12 — the typed platform-web client for the CCP-UI v1.1 / v1.2 reads (all READ-ONLY; the
// console never mutates billing, usage or alert state: PLATFORM-UX-1 Amendment A1-2):
//   GET /platform/commercial/finance/renewals                 platform:billing:read   (CCP-C6)
//   GET /platform/commercial/finance/outstanding-payments     platform:billing:read   (CCP-C6; R3 amount_withheld)
//   GET /platform/commercial/finance/reconciliation-report    platform:billing:read   (CCP-C6)
//   GET /platform/commercial/billing-commands                 platform:billing:read   (CCP-C1; R3 params)
//   GET /platform/commercial/billing-webhook-inbox            platform:billing:read   (CCP-C1)
//   GET /platform/commercial/finance/revenue                  platform:billing:read   (CCP-D2; R3 amount_withheld)
//   GET /platform/commercial/usage/reconciliation             platform:subscription:read (CCP-D1)
//   GET /platform/commercial/usage/periods                    platform:subscription:read (CCP-D1; 409 when not reconciled)
//   GET /platform/commercial/alerts/{billing,approvals}       platform:billing:read / platform:approval:read (CCP-D3)
//   GET /platform/commercial/metrics/{billing,approvals}      the same; the configured thresholds (TD-D3-2)
// Shapes mirror the platform-admin DTOs (apps/platform-admin/src/app/platform/dto/
// commercial-{finance,revenue,usage,observability,billing}.dto.ts) and the platform-web → platform-admin
// Pact consumer. CCP-A1 Amendment A1 (Finance amount scope, LOCKED): a tenant-specific figure is
// ABSENT for a caller without platform:billing:amount:read, with `amount_withheld` set instead.

export type AmountWithheld = 'FINANCE_SCOPE_REQUIRED';

export interface ListPrice {
  amount_minor: number;
  currency: 'USD';
  billing_interval: string | null;
}

export interface PriceFigure {
  list_price: ListPrice | null;
  /** CONTRACT_PRICED | NO_LIST_PRICE | NON_USD_CURRENCY | PLAN_VERSION_INTEGRITY */
  unpriced_reason: string | null;
  /** PINNED_PLAN_VERSION | CURRENT_PUBLISHED_PLAN_VERSION */
  price_source: string;
  plan_version_id: string | null;
}

export interface TaxAvailability {
  enabled: boolean;
  reason?: string;
}

export interface RenewalItem extends PriceFigure {
  subscription_id: string;
  tenant_id: string;
  tenant_name: string | null;
  product_key: string;
  source: string;
  status: string;
  plan_key: string;
  plan_name: string;
  version_number: number;
  grandfathered: boolean;
  /** COMMITMENT_END | PERIOD_END */
  renewal_kind: string;
  renewal_at: string;
  days_until: number;
  lapsed: boolean;
  commitment_months: number | null;
  cancel_at_period_end: boolean;
  cancel_requested_within_commitment: boolean;
}

export interface RenewalsReport {
  as_of: string;
  within_days: number;
  currency: 'USD';
  billing_provider_mode: string;
  tax: TaxAvailability;
  items: RenewalItem[];
  counts: { items: number; lapsed: number; commitment_end: number; period_end: number };
}

export interface OutstandingItem extends PriceFigure {
  subscription_id: string;
  tenant_id: string;
  tenant_name: string | null;
  product_key: string;
  source: string;
  status: string;
  plan_key: string;
  version_number: number;
  billing_subscription_ref: string | null;
  status_since: string | null;
  grace_until: string | null;
  /** IN_GRACE | GRACE_ENDED | NO_GRACE_DATE */
  grace_state: string;
  current_period_end: string | null;
  /** Holders only (always null in v1: invoice reads are not delivered, see `amount_due_reason`). */
  amount_due?: number | null;
  amount_withheld?: AmountWithheld;
  amount_due_reason: string;
  /** CCP-R3 FA-4 booleans; carried here once the outstanding read returns them (MBC-V12-3). */
  payment_due?: boolean;
  payment_overdue?: boolean;
}

export interface OutstandingReport {
  as_of: string;
  currency: 'USD';
  billing_provider_mode: string;
  tax: TaxAvailability;
  items: OutstandingItem[];
  counts: { items: number; past_due: number; incomplete: number; in_grace: number; grace_ended: number; no_grace_date: number };
}

export interface ReconciledSubscription extends PriceFigure {
  subscription_id: string;
  tenant_id: string;
  tenant_name: string | null;
  product_key: string;
  source: string;
  status: string;
  plan_key: string;
  version_number: number;
  version_status: string;
  grandfathered: boolean;
  billing_subscription_ref: string | null;
  provider_price_ref: string | null;
  entitlement: { expected: string[]; present: string[]; missing: string[] };
  open_flag_reasons: string[];
  unconfirmed_command_ids: string[];
  discrepancies: string[];
}

export interface HeldActivation {
  flag_id: string;
  tenant_id: string;
  tenant_name: string | null;
  product_key: string | null;
  provider: string;
  subscription_ref: string;
  detected_at: string;
  intent_id: string | null;
  intent_status: string | null;
  governed_subscription_id: string | null;
  governed_plan_key: string | null;
  held_plan_key: string | null;
  held_price: PriceFigure;
  unconfirmed_commands: Array<{ id: string; command_kind: string; state: string; change_request_id: string | null }>;
  /** UNRESOLVED | PENDING_PROVIDER */
  resolution: string;
}

export interface ReconciliationReport {
  as_of: string;
  currency: 'USD';
  billing_provider_mode: string;
  tax: TaxAvailability;
  /** RECONCILED | EXCEPTIONS */
  status: string;
  subscriptions: ReconciledSubscription[];
  entitled_without_subscription: Array<{
    tenant_id: string;
    tenant_name: string | null;
    product_key: string;
    capabilities: string[];
    residual_authority: string | null;
    residual_authority_until: string | null;
  }>;
  held_activations: HeldActivation[];
  other_open_flags: Array<{ flag_id: string; tenant_id: string; reason: string; provider: string; subscription_ref: string; detected_at: string }>;
  counts: {
    open_subscriptions: number;
    subscriptions_with_discrepancy: number;
    entitled_without_subscription: number;
    held_activations: number;
    other_open_flags: number;
    unconfirmed_commands: number;
    failed_commands: number;
    failed_inbox_events: number;
    unprocessed_inbox_events: number;
    exceptions: number;
  } & Record<string, unknown>;
}

export interface BillingCommand {
  id: string;
  provider: string;
  command_kind: string;
  change_request_id: string | null;
  self_service_request_id: string | null;
  tenant_id: string | null;
  product_key: string | null;
  /** Amount-like params are omitted for a non-holder, with `amount_withheld` (R3, fail closed). */
  params: Record<string, unknown>;
  /** PENDING | DISPATCHING | PENDING_PROVIDER | RETRY_WAIT | FAILED | CONFIRMED */
  state: string;
  pending_provider: boolean;
  attempts: number;
  /** CCP-R3-W: for a non-holder on the five C4 kinds, `{ code, detail_withheld }` (no provider text). */
  failure: { code: string; detail?: string | null; detail_withheld?: AmountWithheld } | null;
  last_detail?: string | null;
  detail_withheld?: AmountWithheld;
  provider_accepted_at: string | null;
  confirmed_at: string | null;
  failed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookInboxEvent {
  id: string;
  provider: string;
  provider_event_id: string;
  event_type: string;
  event_created_at: string;
  subscription_ref: string | null;
  checkout_session_ref: string | null;
  product_key: string | null;
  /** RECEIVED | PROCESSING | PROCESSED | FAILED */
  status: string;
  attempts: number;
  outcome: string | null;
  detail: string | null;
  last_error: string | null;
  received_at: string;
  processed_at: string | null;
}

export interface RevenueBucket {
  /** 'YYYY-MM' (UTC) or 'LAPSED' */
  month: string;
  commitment_end: number;
  period_end: number;
  events: number;
  priced_events: number;
  unpriced_events: number;
  mrr_minor?: number;
  amount_withheld?: AmountWithheld;
}

export interface RevenueReport {
  as_of: string;
  currency: 'USD';
  billing_interval: 'MONTH';
  basis: string;
  billing_provider_mode: string;
  tax: TaxAvailability;
  mrr_minor?: number;
  arr_minor?: number;
  amount_withheld?: AmountWithheld;
  by_product: Array<{ product_key: string; subscriptions: number; mrr_minor?: number; arr_minor?: number; amount_withheld?: AmountWithheld }>;
  counts: {
    open_commercial_subscriptions: number;
    included: number;
    excluded: number;
    excluded_by_reason: Record<string, number>;
    not_commercial_by_source: Record<string, number>;
  };
  renewal_pipeline: { months: number; from_month: string; through_month: string; lapsed: RevenueBucket; by_month: RevenueBucket[] };
}

const F = '/platform/commercial/finance';
const PAGE = 200;

export const financeApi = {
  renewals(withinDays: number): Promise<RenewalsReport> {
    return apiClient.get(`${F}/renewals?within_days=${String(withinDays)}`);
  },
  outstanding(): Promise<OutstandingReport> {
    return apiClient.get(`${F}/outstanding-payments`);
  },
  reconciliation(): Promise<ReconciliationReport> {
    return apiClient.get(`${F}/reconciliation-report`);
  },
  /** One page of commands in a state (FAILED, or pending at the provider). */
  commands(state: 'FAILED' | 'PENDING_PROVIDER'): Promise<{ commands: BillingCommand[]; next_cursor: string | null }> {
    return apiClient.get(`/platform/commercial/billing-commands?state=${state}&limit=${String(PAGE)}`);
  },
  /** One page of inbox events in a status (FAILED, or stalled in PROCESSING). */
  inbox(status: 'FAILED' | 'PROCESSING'): Promise<{ events: WebhookInboxEvent[]; next_cursor: string | null }> {
    return apiClient.get(`/platform/commercial/billing-webhook-inbox?status=${status}&limit=${String(PAGE)}`);
  },
  /** The design's six-month renewals-by-month horizon. */
  revenue(months = 6): Promise<RevenueReport> {
    return apiClient.get(`${F}/revenue?months=${String(months)}`);
  },
};
