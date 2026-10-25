import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { PRODUCT_KEYS, RENEWAL_HORIZON_MAX_DAYS, type ProductKey } from '@aramo/subscription';

// CCP-C6 — GET /platform/commercial/finance/{renewals, outstanding-payments, reconciliation-report}
// (platform:billing:read): the dedicated Finance read routes (A0-C6; PLATFORM-UX-1 A1-4a). They are
// the ONLY platform routes that carry a monetary field. READ-ONLY. Every monetary figure is a plan
// version's USD list price (minor units) per billing interval (catalog authority, FA-3); no amount
// owed and no sum is computed; the amount-owed field needs platform:billing:amount:read (CCP-R3).

export class FinanceReportQueryDto {
  @IsOptional() @IsUUID() tenant_id?: string;
  @IsOptional() @IsIn([...PRODUCT_KEYS]) product_key?: ProductKey;
}

export class FinanceRenewalsQueryDto extends FinanceReportQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(RENEWAL_HORIZON_MAX_DAYS) within_days?: number;
}

export interface ListPriceDto {
  amount_minor: number;
  currency: 'USD';
  billing_interval: string | null;
}

export interface PriceFigureDto {
  list_price: ListPriceDto | null;
  // CONTRACT_PRICED | NO_LIST_PRICE | NON_USD_CURRENCY | PLAN_VERSION_INTEGRITY
  unpriced_reason: string | null;
  // PINNED_PLAN_VERSION | CURRENT_PUBLISHED_PLAN_VERSION
  price_source: string;
  plan_version_id: string | null;
}

export interface RenewalItemDto extends PriceFigureDto {
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
  // COMMITMENT_END | PERIOD_END
  renewal_kind: string;
  renewal_at: string;
  days_until: number;
  lapsed: boolean;
  commitment_months: number | null;
  cancel_at_period_end: boolean;
  cancel_requested_within_commitment: boolean;
}

export interface RenewalsResponseDto {
  as_of: string;
  within_days: number;
  currency: 'USD';
  billing_provider_mode: string;
  items: RenewalItemDto[];
  counts: { items: number; lapsed: number; commitment_end: number; period_end: number };
}

export interface OutstandingItemDto extends PriceFigureDto {
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
  // IN_GRACE | GRACE_ENDED | NO_GRACE_DATE
  grace_state: string;
  current_period_end: string | null;
  // CCP-R3 (CCP-A1 Amendment A1, FA-1 / FA-5): the amount owed is a tenant-specific figure. With
  // platform:billing:amount:read it is `amount_due` (null: never computed here, see the reason);
  // without it the field is absent and `amount_withheld` is set.
  amount_due?: null;
  amount_withheld?: 'FINANCE_SCOPE_REQUIRED';
  amount_due_reason: string;
}

export interface OutstandingPaymentsResponseDto {
  as_of: string;
  currency: 'USD';
  billing_provider_mode: string;
  items: OutstandingItemDto[];
  counts: { items: number; past_due: number; incomplete: number; in_grace: number; grace_ended: number; no_grace_date: number };
}

export interface ReconciledSubscriptionDto extends PriceFigureDto {
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

export interface HeldActivationDto {
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
  held_price: PriceFigureDto;
  unconfirmed_commands: Array<{ id: string; command_kind: string; state: string; change_request_id: string }>;
  // UNRESOLVED | PENDING_PROVIDER
  resolution: string;
}

export interface ReconciliationReportResponseDto {
  as_of: string;
  currency: 'USD';
  billing_provider_mode: string;
  // RECONCILED | EXCEPTIONS
  status: string;
  subscriptions: ReconciledSubscriptionDto[];
  // CCP-R3 (TD-A7-5): residual_authority null = no grace and no live overlay remain (the D3
  // ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION condition; GRACE | SUPPORT_OVERLAY otherwise).
  entitled_without_subscription: Array<{
    tenant_id: string;
    tenant_name: string | null;
    product_key: string;
    capabilities: string[];
    residual_authority: string | null;
    residual_authority_until: string | null;
  }>;
  held_activations: HeldActivationDto[];
  other_open_flags: Array<{ flag_id: string; tenant_id: string; reason: string; provider: string; subscription_ref: string; detected_at: string }>;
  counts: {
    open_subscriptions: number;
    by_source: Record<string, number>;
    by_status: Record<string, number>;
    subscriptions_with_discrepancy: number;
    discrepancies: Record<string, number>;
    entitled_without_subscription: number;
    held_activations: number;
    other_open_flags: number;
    unconfirmed_commands: number;
    failed_commands: number;
    failed_inbox_events: number;
    unprocessed_inbox_events: number;
    exceptions: number;
  };
}
