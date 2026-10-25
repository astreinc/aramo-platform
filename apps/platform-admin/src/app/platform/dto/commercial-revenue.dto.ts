import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { PRODUCT_KEYS, REVENUE_PIPELINE_MAX_MONTHS, type ProductKey } from '@aramo/subscription';

// CCP-D2 — GET /platform/commercial/finance/revenue (platform:billing:read): platform-wide revenue
// reporting, derived from the commercial records (no ledger). READ-ONLY.
//
// Every amount is WITHHELD for every caller (draft CCP-A1 Finance amount scope FA-6, interim): the
// amount fields are absent and each money-bearing object carries amount_withheld:
// FINANCE_SCOPE_PENDING. Counts, the exclusion reasons and the renewal-event counts are returned.
// There is no tenant filter and no per-tenant row (per-tenant revenue is FA-1 scope material).

export class FinanceRevenueQueryDto {
  @IsOptional() @IsIn([...PRODUCT_KEYS]) product_key?: ProductKey;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(REVENUE_PIPELINE_MAX_MONTHS) months?: number;
}

export type AmountWithheld = 'FINANCE_SCOPE_PENDING';

export interface RevenueRenewalBucketDto {
  // 'YYYY-MM' (UTC) or 'LAPSED'
  month: string;
  commitment_end: number;
  period_end: number;
  events: number;
  priced_events: number;
  unpriced_events: number;
  amount_withheld: AmountWithheld;
}

export interface FinanceRevenueResponseDto {
  as_of: string;
  currency: 'USD';
  billing_interval: 'MONTH';
  basis: 'OPEN_SUBSCRIPTIONS_X_PINNED_LIST_PRICE';
  billing_provider_mode: string;
  amount_withheld: AmountWithheld;
  by_product: Array<{ product_key: string; subscriptions: number; amount_withheld: AmountWithheld }>;
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
