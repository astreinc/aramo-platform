import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { BILLING_STATUS_MAX_INVOICE_LIMIT, PRODUCT_KEYS, type ProductKey } from '@aramo/subscription';

// CCP-C3 — GET /platform/commercial/tenants/{tenant_id}/billing-status and
// GET /platform/commercial/billing-portal-configuration (platform:billing:read): READ-THROUGH
// invoice and payment status and the portal-configuration facts. READ-ONLY. The query DTO is the
// 400-shape gate. Money (invoice amounts) appears only in the billing-status response, which serves
// a dedicated billing (Finance) screen (PLATFORM-UX-1 A1-4a), never a dashboard.

export class TenantBillingStatusQueryDto {
  @IsIn([...PRODUCT_KEYS]) product_key!: ProductKey;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(BILLING_STATUS_MAX_INVOICE_LIMIT) invoice_limit?: number;
}

/** No parameters: the configuration id comes from STRIPE_PORTAL_CONFIGURATION only, never from the caller. */
export class BillingPortalConfigurationQueryDto {}

export interface BillingStatusInvoiceDto {
  provider: string;
  invoice_ref: string;
  number: string | null;
  subscription_ref: string | null;
  // Raw provider status (draft | open | paid | uncollectible | void).
  provider_status: string;
  // DRAFT | DUE | OVERDUE | PAYMENT_FAILED | PAID | UNCOLLECTIBLE | VOID | UNKNOWN
  payment_state: string;
  currency: string | null;
  total_minor: number;
  amount_due_minor: number;
  amount_paid_minor: number;
  amount_remaining_minor: number;
  created_at: string | null;
  due_at: string | null;
  period_start: string | null;
  period_end: string | null;
  attempt_count: number;
  next_attempt_at: string | null;
  hosted_url: string | null;
  document_url: string | null;
}

export interface TenantBillingStatusResponseDto {
  tenant_id: string;
  product_key: string;
  // AVAILABLE | BILLING_UNAVAILABLE | LIVE_MODE_HELD | NO_PROVIDER_SUBSCRIPTION | PROVIDER_UNAVAILABLE | TENANT_MISMATCH
  availability: string;
  provider: string | null;
  mode: string | null;
  subscription: { id: string; source: string; status: string; open: boolean; account_ref: string; subscription_ref: string } | null;
  provider_subscription: { provider_status: string; current_period_start: string; current_period_end: string; cancel_at_period_end: boolean } | null;
  invoices: BillingStatusInvoiceDto[];
  detail: string | null;
  read_at: string;
}

export interface BillingPortalConfigurationResponseDto {
  provider: string;
  // AVAILABLE | BILLING_UNAVAILABLE | LIVE_MODE_HELD | PROVIDER_UNAVAILABLE
  availability: string;
  mode: string | null;
  configuration_ref: string | null;
  // NOT_CONFIGURED | NOT_FOUND | INACTIVE | ACTIVE (null when it could not be read)
  configuration_state: string | null;
  configuration: {
    active: boolean;
    is_default: boolean;
    live: boolean;
    invoice_history_enabled: boolean;
    payment_method_update_enabled: boolean;
    subscription_cancel_enabled: boolean;
    subscription_cancel_mode: string | null;
    subscription_update_enabled: boolean;
  } | null;
  detail: string | null;
  read_at: string;
}
