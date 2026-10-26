import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { BillingRevenueReportService, FINANCE_AMOUNT_WITHHELD, taxAvailability, type RenewalBucket, type RevenueReport } from '@aramo/subscription';

import { amountAccess } from './finance-amount-access.js';
import { FinanceRevenueQueryDto, type FinanceRevenueResponseDto, type RevenueRenewalBucketDto } from './dto/commercial-revenue.dto.js';

// CCP-D2 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.4 row D2; ruling A0-C6; PLATFORM-UX-1
// Amendment A1-4a) — the dedicated Finance revenue READ route: the illustrative list-price monthly
// value (mrr_minor) and its annualized value (arr_minor; NOT recognized MRR / ARR, Architect W-1,
// recognized_revenue: false) and the renewal pipeline by
// month, derived from the commercial records (BillingRevenueReportService; no ledger).
//
//   GET finance/revenue   product_key, months (1..24, default 12)
//
// Gate: platform:billing:read (CCP A1 §4.1: platform_owner, finance_admin, commercial_ops,
// support_admin, read_only_auditor; never catalog_manager, never super_admin), platform tier only.
//
// AMOUNTS (CCP-R3; Aramo-CCP-A1-Amendment-A1-Finance-Amount-Scope-v1_0 LOCKED, FA-1 / FA-5 / FA-6):
// the platform-wide illustrative list-price values (mrr_minor, arr_minor, the buckets' mrr_minor;
// never recognized revenue, Architect W-1) are a Finance amount. A
// caller holding platform:billing:read AND platform:billing:amount:read (platform_owner,
// finance_admin, read_only_auditor) receives mrr_minor / arr_minor on the report and each product
// line and mrr_minor on each renewal bucket. Every other reader receives the counts only: the
// amount fields are OMITTED and each money-bearing object carries amount_withheld:
// FINANCE_SCOPE_REQUIRED. The decision reads the server-resolved scopes of this request
// (amountAccess), and the projection builds each field explicitly, so a non-holder's body is built
// without reading any amount field of the report. The route also serves counts, so a non-holder is
// not refused (FA-5's 403 is for routes that exist only to serve amounts).

function assertPlatform(auth: AuthContextType, requestId: string): void {
  if (auth.consumer_type !== 'platform') {
    throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
      requestId,
      details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
    });
  }
}

function bucketDto(b: RenewalBucket, withAmounts: boolean): RevenueRenewalBucketDto {
  const base = {
    month: b.month,
    commitment_end: b.commitment_end,
    period_end: b.period_end,
    events: b.events,
    priced_events: b.priced_events,
    unpriced_events: b.unpriced_events,
  };
  return withAmounts ? { ...base, mrr_minor: b.mrr_minor } : { ...base, amount_withheld: FINANCE_AMOUNT_WITHHELD };
}

/** The FA-5 projection: amounts only for a Finance amount scope holder; counts and states for every reader. */
export function revenueDto(r: RevenueReport, withAmounts: boolean): FinanceRevenueResponseDto {
  const amounts = withAmounts ? { mrr_minor: r.mrr_minor, arr_minor: r.arr_minor } : { amount_withheld: FINANCE_AMOUNT_WITHHELD };
  return {
    as_of: r.as_of.toISOString(),
    currency: r.currency,
    billing_interval: r.billing_interval,
    basis: r.basis,
    // Architect W-1 (merge train TD-MERGE-47): an illustrative list-price value, never recognized revenue.
    recognized_revenue: false,
    billing_provider_mode: r.billing_provider_mode,
    // CCP-C5 (merge train TD-MERGE-41): the designed disabled tax state, as on every other billing read.
    tax: taxAvailability(),
    ...amounts,
    by_product: r.by_product.map((p) =>
      withAmounts
        ? { product_key: p.product_key, subscriptions: p.subscriptions, mrr_minor: p.mrr_minor, arr_minor: p.arr_minor }
        : { product_key: p.product_key, subscriptions: p.subscriptions, amount_withheld: FINANCE_AMOUNT_WITHHELD },
    ),
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
      lapsed: bucketDto(r.renewal_pipeline.lapsed, withAmounts),
      by_month: r.renewal_pipeline.by_month.map((b) => bucketDto(b, withAmounts)),
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
    return revenueDto(await this.revenue.revenue({ product_key: query.product_key, months: query.months }), amountAccess(auth));
  }
}
