import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { CommercialAlertQueryError, CommercialAlertService, type CommercialAlertFamily, type CommercialAlertRow } from '@aramo/subscription';

import {
  ApprovalAlertQueryDto,
  BillingAlertQueryDto,
  OperationsMetricsQueryDto,
  type ApprovalOperationsMetricsDto,
  type BillingOperationsMetricsDto,
  type CommercialAlertDto,
  type CommercialAlertListResponseDto,
} from './dto/commercial-observability.dto.js';

// CCP-D3 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.4 row D3: billing and approval metrics,
// alerts, exception management; Out: health or rating metrics, PLATFORM-UX-1 :139) — READ-ONLY
// operator views of the operational alert register and counts-and-states metrics. Platform
// consumer only. No mutation route (PLATFORM-UX-1 A1-2): an alert resolves itself when the next
// scan no longer observes its condition; the condition is cleared on its governed path.
//
//   GET alerts/billing      platform:billing:read   (platform_owner, finance_admin, commercial_ops,
//   GET metrics/billing                              support_admin, read_only_auditor)
//   GET alerts/approvals    platform:approval:read  (the 6 CCP roles)
//   GET metrics/approvals
// super_admin holds neither scope (INV-1). Metrics are platform-wide counts by state: never per
// tenant, never ordered by tenant, never money.

function assertPlatform(auth: AuthContextType, requestId: string): void {
  if (auth.consumer_type !== 'platform') {
    throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
      requestId,
      details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
    });
  }
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function commercialAlertDto(row: CommercialAlertRow): CommercialAlertDto {
  return {
    id: row.id,
    alert_type: row.alert_type,
    family: row.family,
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    tenant_id: row.tenant_id,
    product_key: row.product_key,
    status: row.status,
    detail: row.detail,
    evidence: (row.evidence ?? {}) as Record<string, unknown>,
    threshold_minutes: row.threshold_minutes,
    detection_count: row.detection_count,
    first_detected_at: row.first_detected_at.toISOString(),
    last_detected_at: row.last_detected_at.toISOString(),
    resolved_at: iso(row.resolved_at),
    resolution_detail: row.resolution_detail,
  };
}

@Controller('platform/commercial')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformCommercialObservabilityController {
  constructor(private readonly alerts: CommercialAlertService) {}

  private async listFamily(family: CommercialAlertFamily, query: BillingAlertQueryDto | ApprovalAlertQueryDto, requestId: string): Promise<CommercialAlertListResponseDto> {
    try {
      const page = await this.alerts.list(family, { status: query.status, alert_type: query.alert_type, tenant_id: query.tenant_id, limit: query.limit, cursor: query.cursor });
      return { alerts: page.alerts.map(commercialAlertDto), next_cursor: page.next_cursor };
    } catch (err) {
      if (err instanceof CommercialAlertQueryError) {
        throw new AramoError('VALIDATION_ERROR', err.message, 400, { requestId, details: { reason: err.code === 'INVALID_CURSOR' ? 'invalid_cursor' : 'invalid_query' } });
      }
      throw err;
    }
  }

  @Get('alerts/billing')
  @RequireScopes('platform:billing:read')
  async listBillingAlerts(@Query() query: BillingAlertQueryDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<CommercialAlertListResponseDto> {
    assertPlatform(auth, requestId);
    return this.listFamily('BILLING', query, requestId);
  }

  @Get('alerts/approvals')
  @RequireScopes('platform:approval:read')
  async listApprovalAlerts(@Query() query: ApprovalAlertQueryDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<CommercialAlertListResponseDto> {
    assertPlatform(auth, requestId);
    return this.listFamily('APPROVAL', query, requestId);
  }

  @Get('metrics/billing')
  @RequireScopes('platform:billing:read')
  async billingMetrics(@Query() _query: OperationsMetricsQueryDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<BillingOperationsMetricsDto> {
    assertPlatform(auth, requestId);
    const m = await this.alerts.billingMetrics(new Date());
    return { ...m, as_of: m.as_of.toISOString() };
  }

  @Get('metrics/approvals')
  @RequireScopes('platform:approval:read')
  async approvalMetrics(@Query() _query: OperationsMetricsQueryDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<ApprovalOperationsMetricsDto> {
    assertPlatform(auth, requestId);
    const m = await this.alerts.approvalMetrics(new Date());
    return { ...m, as_of: m.as_of.toISOString() };
  }
}
