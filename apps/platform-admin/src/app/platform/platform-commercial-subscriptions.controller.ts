import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
// NOT `import type`: NestJS constructor injection needs the class as a runtime DI token.
import { CommercialSubscriptionReadService, type WorkbenchSubscription } from '@aramo/subscription';

import type {
  CommercialSubscriptionSummaryDto,
  CommercialSubscriptionsResponseDto,
  CommercialTenantOverviewResponseDto,
} from './dto/commercial-subscriptions.dto.js';
import { CommercialSubscriptionsQueryDto } from './dto/commercial-subscriptions.dto.js';

// CCP-B3 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.3 row B3; pre-execution record C-1) —
// the READ-ONLY reads behind the Subscriptions workbench and the tenant Commercial tab. No money:
// no price, amount or currency is returned (PLATFORM-UX-1 Amendment A1-4a; prices stay on the
// Finance screens). Held activations (open reconciliation flags) are surfaced to operators with
// their linked conversion request (Conversion Rule C-8). This controller writes nothing; every
// change goes through a governed change request.
//
//   GET subscriptions                      the latest BASE row per tenant × product (open, else
//                                          the most recently ended).
//   GET tenants/{tenant_id}/commercial     per product: entitlement + provenance, the latest BASE
//                                          row, open flags, the open (Q14) change request.
//
// Gate `platform:subscription:read` (CCP A1 §4.1: platform_owner, finance_admin, commercial_ops,
// support_admin, read_only_auditor; NOT catalog_manager, NOT super_admin — INV-1, PBD §12).
// Platform consumer only (the DDR §13.1 tripwire).

@Controller('platform/commercial')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformCommercialSubscriptionsController {
  constructor(private readonly reads: CommercialSubscriptionReadService) {}

  @Get('subscriptions')
  @RequireScopes('platform:subscription:read')
  async list(
    @Query() query: CommercialSubscriptionsQueryDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CommercialSubscriptionsResponseDto> {
    assertPlatform(auth, requestId);
    const r = await this.reads.listWorkbench({ product_key: query.product_key });
    return {
      as_of: r.as_of.toISOString(),
      rows: r.rows.map((row) => ({ ...summaryDto(row), tenant: { id: row.tenant.id, name: row.tenant.name, slug: row.tenant.slug } })),
    };
  }

  @Get('tenants/:tenant_id/commercial')
  @RequireScopes('platform:subscription:read')
  async tenant(
    @Param('tenant_id', new ParseUUIDPipe()) tenant_id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CommercialTenantOverviewResponseDto> {
    assertPlatform(auth, requestId);
    const o = await this.reads.tenantOverview(tenant_id);
    if (o === null) throw new AramoError('NOT_FOUND', 'Tenant not found', 404, { requestId, details: { tenant_id } });
    return {
      as_of: o.as_of.toISOString(),
      tenant: { id: o.tenant.id, name: o.tenant.name, slug: o.tenant.slug, kind: o.tenant.kind },
      products: o.products.map((p) => ({
        product_key: p.product_key,
        registered: p.registered,
        entitlement: {
          capability: p.entitlement.capability,
          state: p.entitlement.state,
          granted_source: p.entitlement.granted_source,
          granted_at: iso(p.entitlement.granted_at),
          granted_by: p.entitlement.granted_by,
          change_request_id: p.entitlement.change_request_id,
          revoked_at: iso(p.entitlement.revoked_at),
          revoked_by: p.entitlement.revoked_by,
          revoke_change_request_id: p.entitlement.revoke_change_request_id,
        },
        subscription: p.subscription === null ? null : summaryDto(p.subscription),
        flags: p.flags.map((f) => ({
          id: f.id,
          reason: f.reason,
          provider: f.provider,
          subscription_ref: f.subscription_ref,
          intent_id: f.intent_id,
          detected_at: f.detected_at.toISOString(),
          conversion: f.conversion === null ? null : { change_request_id: f.conversion.change_request_id, state: f.conversion.state, direction: f.conversion.direction },
        })),
        open_request:
          p.open_request === null
            ? null
            : {
                id: p.open_request.id,
                action_type: p.open_request.action_type,
                kind: p.open_request.kind,
                state: p.open_request.state,
                requested_by: p.open_request.requested_by,
                created_at: p.open_request.created_at.toISOString(),
              },
      })),
    };
  }
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function summaryDto(s: WorkbenchSubscription): CommercialSubscriptionSummaryDto {
  return {
    subscription_id: s.subscription_id,
    product_key: s.product_key,
    plan: { id: s.plan.id, key: s.plan.key, name: s.plan.name, sales_model: s.plan.sales_model },
    plan_version: { id: s.plan_version.id, version_number: s.plan_version.version_number, status: s.plan_version.status },
    source: s.source,
    status: s.status,
    started_at: s.started_at.toISOString(),
    ended_at: iso(s.ended_at),
    period_anchor: s.period_anchor.toISOString(),
    current_period: s.current_period === null ? null : { start: s.current_period.start.toISOString(), end: s.current_period.end.toISOString() },
    current_period_end: iso(s.current_period_end),
    grace_until: iso(s.grace_until),
    commitment_end: iso(s.commitment_end),
    contract: s.contract === null ? null : { id: s.contract.id, contract_ref: s.contract.contract_ref },
    provider_linked: s.provider_linked,
    open_flags: [...s.open_flags],
    active_extensions: { count: s.active_extensions.count, exception: s.active_extensions.exception },
  };
}

function assertPlatform(auth: AuthContextType, requestId: string): void {
  if (auth.consumer_type !== 'platform') {
    throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
      requestId,
      details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
    });
  }
}
