import { Controller, Get, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { CommercialBillingRegionReadService, type BillingRegionConsoleDetail } from '@aramo/subscription';

import type { BillingRegionDto, BillingRegionListDto } from './dto/commercial-billing-regions.dto.js';

// India Billing Regions + Razorpay Directive v1.0 (LOCKED) §4.10, ruling Q3 — Commercial › Billing regions.
// Platform consumer only. Route gate `platform:catalog:read` (the 6 CCP roles; never super_admin).
//
//   GET /platform/commercial/billing-regions  every region (a handful of rows): gateway, currency, selling
//                                             entity and its registration identifiers (§5), switches, price
//                                             tax mode, gateway configured (G-2), the G-3 refusal that would
//                                             stop it going ON, and the region's open change requests
//
// There is deliberately NO write route here: a change is a BILLING_REGION_CHANGE change request on the
// shared route (POST /platform/commercial/change-requests, requester scope platform:catalog:draft, chain
// Finance), applied by its requester through POST /platform/commercial/change-requests/{id}/apply (G-3
// re-checked at apply). The registration identifiers are returned to the catalog readers only and are
// never logged.

@Controller('platform/commercial/billing-regions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformCommercialBillingRegionsController {
  constructor(private readonly regions: CommercialBillingRegionReadService) {}

  @Get()
  @RequireScopes('platform:catalog:read')
  async list(@AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<BillingRegionListDto> {
    platformOnly(auth, requestId);
    return { regions: (await this.regions.listDetailed()).map(regionDto) };
  }
}

export function regionDto(r: BillingRegionConsoleDetail): BillingRegionDto {
  return {
    country: r.country,
    gateway: r.gateway,
    currency: r.currency,
    enabled: r.enabled,
    personal_web_enabled: r.personal_web_enabled,
    business_web_enabled: r.business_web_enabled,
    price_tax_mode: r.price_tax_mode,
    selling_entity: { ...r.selling_entity },
    gateway_configured: r.gateway_configured,
    enable_refusal: r.enable_refusal,
    registration: { ...r.registration },
    open_requests: r.open_requests.map((o) => ({ id: o.id, state: o.state, requested_by: o.requested_by, created_at: o.created_at.toISOString(), expires_at: o.expires_at === null ? null : o.expires_at.toISOString() })),
  };
}

function platformOnly(auth: AuthContextType, requestId: string): void {
  if (auth.consumer_type !== 'platform') {
    throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
      requestId,
      details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
    });
  }
}
