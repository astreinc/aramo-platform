import { Controller, Get, HttpCode, HttpStatus, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RequireSiteMatch, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { OfferStartWorklistReadService } from './offer-start-worklist-read.service.js';
import type { OfferStartWorklistResponse } from './dto/offer-start-worklist.view.js';

// Offer & Start §9 — the cross-requisition Offer & Start worklist read surface (UI: Placements /
// Offers & Starts). A GET-only projection; the guard chain is the A2 pattern verbatim
// (tenant→scope→site). Read scope is `pipeline:read` — the SAME authority as the per-episode
// journey, because every worklist row IS a journey episode; no new scope is minted. Visibility
// (AUTHZ-D4b) is resolved to the actor's visible requisition set and threaded into every owner
// read server-side (no fetch-all-then-filter, §9.4).
@Controller('v1/offer-start-worklist')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class OfferStartWorklistController {
  constructor(private readonly worklist: OfferStartWorklistReadService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pipeline:read')
  @RequireSiteMatch()
  async getWorklist(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<OfferStartWorklistResponse> {
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    return this.worklist.getWorklist({
      tenant_id: authContext.tenant_id,
      visible_requisition_ids: visibleReqIds,
      requestId,
    });
  }
}
