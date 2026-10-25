import { Type } from 'class-transformer';
import { IsIn, IsISO8601, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min } from 'class-validator';

// CCP-D1 (PBD §5.4 row D1) — GET /platform/commercial/usage/reconciliation and
// GET /platform/commercial/usage/periods (platform:subscription:read). The query DTOs are the
// 400-shape gate; UsageRollupService (libs/subscription) is the authority. Counts only: no
// price, amount or rate is ever returned (usage-based pricing is out; A0-C6 money stays on
// the Finance screens).

export class CommercialUsageReconciliationQueryDto {
  // The CCP-A4 product registry (v1: sign only).
  @IsOptional() @IsIn(['sign']) product_key?: 'sign';
}

export class CommercialUsagePeriodsQueryDto {
  @IsOptional() @IsIn(['sign']) product_key?: 'sign';
  @IsOptional() @IsString() @Matches(/^[a-z][a-z0-9_]*\.[a-z0-9_.]+$/) metric_key?: string;
  @IsOptional() @IsUUID() tenant_id?: string;
  // Inclusive lower bound on period_start.
  @IsOptional() @IsISO8601({ strict: true }) from?: string;
  // Exclusive upper bound on period_start.
  @IsOptional() @IsISO8601({ strict: true }) to?: string;
  @IsOptional() @IsIn(['true', 'false']) include_daily?: 'true' | 'false';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

export interface UsageCountsDto {
  consumed: number;
  consumed_send: number;
  consumed_historical: number;
  reserved: number;
}

export interface UsageMismatchDto {
  kind: 'PERIOD' | 'DAILY' | 'USAGE_EVENT' | 'ROLLUP_USAGE_EVENT';
  tenant_id: string;
  period_start: string | null;
  expected: UsageCountsDto | number;
  actual: UsageCountsDto | number | null;
}

export interface UsageMetricReconciliationDto {
  metric_key: string;
  product_key: string;
  status: 'NOT_RUN' | 'RECONCILED' | 'NOT_RECONCILED';
  watermark: string | null;
  last_run_id: string | null;
  buckets: { source: number; rollup: number; pending: number; compared: number; mismatched: number };
  compared_totals: { allowance_usage: UsageCountsDto; rollup: UsageCountsDto };
  usage_event: { event_type: string | null; tenants: number; mismatched_tenants: number; allowance_usage_consumed_send: number; usage_event_quantity: number };
  mismatch_count: number;
  mismatches: UsageMismatchDto[];
}

export interface CommercialUsageReconciliationResponseDto {
  product_key: string;
  status: 'NOT_RUN' | 'RECONCILED' | 'NOT_RECONCILED';
  checked_at: string;
  metrics: UsageMetricReconciliationDto[];
}

export interface UsagePeriodDto {
  tenant_id: string;
  metric_key: string;
  product_key: string;
  period_start: string;
  period_end: string | null;
  alignment: 'ALIGNED' | 'UNALIGNED';
  subscription_id: string | null;
  plan_version_id: string | null;
  included_quantity: number | null;
  unlimited: boolean | null;
  counts: UsageCountsDto;
  stale: boolean;
  computed_at: string;
  days?: Array<{ usage_date: string; counts: UsageCountsDto }>;
}

export interface CommercialUsagePeriodsResponseDto {
  product_key: string;
  reconciliation: { status: 'RECONCILED'; checked_at: string };
  periods: UsagePeriodDto[];
  truncated: boolean;
}
