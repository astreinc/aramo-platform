import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementRepository } from '@aramo/entitlement';
import { TenantService } from '@aramo/identity';
import { ESIGN_ENVELOPE_ALLOWANCE, SubscriptionLifecycleService } from '@aramo/subscription';

// Aramo Sign launch — the operator's READ-ONLY view of a tenant's Aramo Sign
// account (support for the standalone product): product capabilities, the
// effective subscription and this period's usage, and the recent billing-
// provider events. platform:tenant:read, platform consumer only (the DDR §13.1
// tripwire, same as PlatformController). No mutation lives here: granting or
// revoking a capability and operator-opened subscriptions are governed
// commercial actions (not built).

@Controller('platform')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformSignController {
  constructor(
    private readonly tenants: TenantService,
    private readonly entitlements: EntitlementRepository,
    private readonly lifecycle: SubscriptionLifecycleService,
  ) {}

  @Get('tenants/:tenant_id/sign')
  @RequireScopes('platform:tenant:read')
  async sign(@Param('tenant_id', new ParseUUIDPipe()) tenant_id: string, @AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    if (auth.consumer_type !== 'platform') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
        requestId,
        details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
      });
    }
    const tenant = await this.tenants.getTenantById(tenant_id);
    if (tenant === null) throw new AramoError('NOT_FOUND', 'Tenant not found', 404, { requestId, details: { tenant_id } });
    const [capabilities, account, events] = await Promise.all([
      this.entitlements.getCapabilities(tenant_id),
      this.lifecycle.account(tenant_id, ESIGN_ENVELOPE_ALLOWANCE),
      this.lifecycle.recentBillingEvents(tenant_id),
    ]);
    return {
      tenant_id,
      tenant_kind: tenant.kind,
      capabilities: [...capabilities].sort(),
      sign_entitled: capabilities.has('esign'),
      subscription: account.subscription,
      allowance: account.allowance,
      billing_available: account.billing_available,
      billing_events: events,
    };
  }
}
