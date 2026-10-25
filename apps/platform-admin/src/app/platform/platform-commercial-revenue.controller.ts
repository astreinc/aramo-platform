import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { BillingRevenueReportService, FINANCE_SCOPE_PENDING, type RenewalBucket, type RevenueReport } from '@aramo/subscription';

import { FinanceRevenueQueryDto, type FinanceRevenueResponseDto, type RevenueRenewalBucketDto } from './dto/commercial-revenue.dto.js';

// CCP-D2 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.4 row D2; ruling A0-C6; PLATFORM-UX-1
// Amendment A1-4a) — the dedicated Finance revenue READ route: MRR / ARR and the renewal pipeline by
// month, derived from the commercial records (BillingRevenueReportService; no ledger).
//
//   GET finance/revenue   product_key, months (1..24, default 12)
//
// Gate: platform:billing:read (CCP A1 §4.1: platform_owner, finance_admin, commercial_ops,
// support_admin, read_only_auditor; never catalog_manager, never super_admin), platform tier only.
//
// AMOUNTS ARE WITHHELD FOR EVERY CALLER. Platform-wide aggregate revenue needs the dedicated Finance
// amount scope (Architect disposition 2026-10-25 on TD-C3-5 / TD-C6-1 / TD-D3-13; draft CCP-A1
// Finance amount scope FA-3), which is not LOCKED. Until it is, FA-6 applies: the response carries
// the counts only, and every money-bearing object says amount_withheld: FINANCE_SCOPE_PENDING. The
// projection below builds each field explicitly and never reads an amount field of the report, so
// no amount can reach the wire. Exposing amounts later is a scope-catalog change, not a flag here.

function assertPlatform(auth: AuthContextType, requestId: string): void {
  if (auth.consumer_type !== 'platform') {
    throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
      requestId,
      details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
    });
  }
}

function bucketDto(b: RenewalBucket): RevenueRenewalBucketDto {
  return {
    month: b.month,
    commitment_end: b.commitment_end,
    period_end: b.period_end,
    events: b.events,
    priced_events: b.priced_events,
    unpriced_events: b.unpriced_events,
    amount_withheld: FINANCE_SCOPE_PENDING,
  };
}

/** The FA-6 projection: counts and states only; every amount withheld. */
export function withheldRevenueDto(r: RevenueReport): FinanceRevenueResponseDto {
  return {
    as_of: r.as_of.toISOString(),
    currency: r.currency,
    billing_interval: r.billing_interval,
    basis: r.basis,
    billing_provider_mode: r.billing_provider_mode,
    amount_withheld: FINANCE_SCOPE_PENDING,
    by_product: r.by_product.map((p) => ({ product_key: p.product_key, subscriptions: p.subscriptions, amount_withheld: FINANCE_SCOPE_PENDING })),
    counts: {
      open_commercial_subscriptions: r.counts.open_commercial_subscriptions,
      included: r.counts.included,
      excluded: r.counts.excluded,
      excluded_by_reason: { ...r.counts.excluded_by_reason },
      not_commercial_by_source: { ...r.counts.not_commercial_by_source },
    },
    renewal_pipeline: {
      months: r.renewal_pipeline.months,
      from_month: r.renewal_pipeline.from_month,
      through_month: r.renewal_pipeline.through_month,
      lapsed: bucketDto(r.renewal_pipeline.lapsed),
      by_month: r.renewal_pipeline.by_month.map(bucketDto),
    },
  };
}

@Controller('platform/commercial/finance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformCommercialRevenueController {
  constructor(private readonly revenue: BillingRevenueReportService) {}

  @Get('revenue')
  @RequireScopes('platform:billing:read')
  async report(@Query() query: FinanceRevenueQueryDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<FinanceRevenueResponseDto> {
    assertPlatform(auth, requestId);
    return withheldRevenueDto(await this.revenue.revenue({ product_key: query.product_key, months: query.months }));
  }
}
