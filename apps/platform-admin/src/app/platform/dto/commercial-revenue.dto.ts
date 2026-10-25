import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { PRODUCT_KEYS, REVENUE_PIPELINE_MAX_MONTHS, type ProductKey } from '@aramo/subscription';

// CCP-D2 — GET /platform/commercial/finance/revenue (platform:billing:read): platform-wide revenue
// reporting, derived from the commercial records (no ledger). READ-ONLY.
//
// CCP-R3 (Finance amount scope, LOCKED; FA-1 / FA-5): with platform:billing:amount:read the
// money-bearing objects carry mrr_minor / arr_minor (buckets: mrr_minor); without it those fields
// are absent and amount_withheld: FINANCE_SCOPE_REQUIRED is set. Counts, the exclusion reasons and
// the renewal-event counts are returned to every reader.
// There is no tenant filter and no per-tenant row (per-tenant revenue is FA-1 scope material).

export class FinanceRevenueQueryDto {
  @IsOptional() @IsIn([...PRODUCT_KEYS]) product_key?: ProductKey;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(REVENUE_PIPELINE_MAX_MONTHS) months?: number;
}

export type AmountWithheld = 'FINANCE_SCOPE_REQUIRED';

export interface RevenueRenewalBucketDto {
  // 'YYYY-MM' (UTC) or 'LAPSED'
  month: string;
  commitment_end: number;
  period_end: number;
  events: number;
  priced_events: number;
  unpriced_events: number;
  mrr_minor?: number;
  amount_withheld?: AmountWithheld;
}

export interface FinanceRevenueResponseDto {
  as_of: string;
  currency: 'USD';
  billing_interval: 'MONTH';
  basis: 'OPEN_SUBSCRIPTIONS_X_PINNED_LIST_PRICE';
  billing_provider_mode: string;
  // CCP-C5: always { enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' }.
  tax: { enabled: false; reason: 'STRIPE_TAX_NOT_REGISTERED' };
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
  renewal_pipeline: {
    months: number;
    from_month: string;
    through_month: string;
    lapsed: RevenueRenewalBucketDto;
    by_month: RevenueRenewalBucketDto[];
  };
}
