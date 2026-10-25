import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
// NOT `import type`: NestJS constructor injection needs the class as a runtime DI token.
import { ProductContextError, UsageRollupService, type UsageReconciliation } from '@aramo/subscription';

import type { CommercialUsagePeriodsResponseDto, CommercialUsageReconciliationResponseDto } from './dto/commercial-usage.dto.js';
import { CommercialUsagePeriodsQueryDto, CommercialUsageReconciliationQueryDto } from './dto/commercial-usage.dto.js';

// CCP-D1 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.4 row D1) — the READ-ONLY usage
// roll-up surface. platform:subscription:read (CCP A1 §4.1: platform_owner, finance_admin,
// commercial_ops, support_admin, read_only_auditor); catalog_manager and super_admin hold no
// such scope and are refused (INV-1, PBD §12). Platform consumer only (the DDR §13.1 tripwire).
//
//   GET usage/reconciliation  the live reconciliation of the roll-ups against the AllowanceUsage
//                             ledger and the metering raw events (always answers).
//   GET usage/periods         consumption analytics per tenant × metric × billing period. Read-only
//                             until reconciled: refused 409 USAGE_ROLLUP_NOT_RECONCILED unless the
//                             live status is RECONCILED. Counts only, never money.

@Controller('platform/commercial/usage')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformCommercialUsageController {
  constructor(private readonly usage: UsageRollupService) {}

  @Get('reconciliation')
  @RequireScopes('platform:subscription:read')
  async reconciliation(
    @Query() query: CommercialUsageReconciliationQueryDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CommercialUsageReconciliationResponseDto> {
    assertPlatform(auth, requestId);
    return toReconciliationDto(await this.usage.reconcile(query.product_key ?? 'sign'));
  }

  @Get('periods')
  @RequireScopes('platform:subscription:read')
  async periods(
    @Query() query: CommercialUsagePeriodsQueryDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CommercialUsagePeriodsResponseDto> {
    assertPlatform(auth, requestId);
    const product_key = query.product_key ?? 'sign';
    const from = query.from === undefined ? undefined : new Date(query.from);
    const to = query.to === undefined ? undefined : new Date(query.to);
    if (from !== undefined && to !== undefined && from.getTime() >= to.getTime()) {
      throw new AramoError('VALIDATION_ERROR', '`from` must be earlier than `to`', 400, { requestId, details: { reason: 'invalid_date_range' } });
    }
    let result;
    try {
      result = await this.usage.listPeriods({
        product_key,
        metric_key: query.metric_key,
        tenant_id: query.tenant_id,
        from,
        to,
        include_daily: query.include_daily === 'true',
        limit: query.limit,
      });
    } catch (err) {
      if (err instanceof ProductContextError) {
        throw new AramoError('VALIDATION_ERROR', err.message, 400, { requestId, details: { reason: 'unknown_metric' } });
      }
      throw err;
    }
    if (!result.ok) {
      const rec = result.reconciliation;
      throw new AramoError('USAGE_ROLLUP_NOT_RECONCILED', 'Usage roll-ups are read-only until their totals reconcile', 409, {
        requestId,
        details: { status: rec.status, mismatch_count: rec.metrics.reduce((s, m) => s + m.mismatch_count, 0), checked_at: rec.checked_at.toISOString() },
      });
    }
    return {
      product_key,
      reconciliation: { status: 'RECONCILED', checked_at: result.reconciliation.checked_at.toISOString() },
      truncated: result.truncated,
      periods: result.periods.map((p) => ({
        tenant_id: p.tenant_id,
        metric_key: p.metric_key,
        product_key: p.product_key,
        period_start: p.period_start.toISOString(),
        period_end: p.period_end === null ? null : p.period_end.toISOString(),
        alignment: p.alignment,
        subscription_id: p.subscription_id,
        plan_version_id: p.plan_version_id,
        included_quantity: p.included_quantity,
        unlimited: p.unlimited,
        counts: { ...p.counts },
        stale: p.stale,
        computed_at: p.computed_at.toISOString(),
        ...(p.days !== undefined ? { days: p.days.map((d) => ({ usage_date: d.usage_date, counts: { ...d.counts } })) } : {}),
      })),
    };
  }
}

function assertPlatform(auth: AuthContextType, requestId: string): void {
  if (auth.consumer_type !== 'platform') {
    throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
      requestId,
      details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
    });
  }
}

export function toReconciliationDto(r: UsageReconciliation): CommercialUsageReconciliationResponseDto {
  return {
    product_key: r.product_key,
    status: r.status,
    checked_at: r.checked_at.toISOString(),
    metrics: r.metrics.map((m) => ({
      metric_key: m.metric_key,
      product_key: m.product_key,
      status: m.status,
      watermark: m.watermark,
      last_run_id: m.last_run_id,
      buckets: { ...m.buckets },
      compared_totals: { allowance_usage: { ...m.compared_totals.allowance_usage }, rollup: { ...m.compared_totals.rollup } },
      usage_event: { ...m.usage_event },
      mismatch_count: m.mismatch_count,
      mismatches: m.mismatches.map((x) => ({ ...x })),
    })),
  };
}
