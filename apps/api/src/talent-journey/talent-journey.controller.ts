import { Controller, Get, HttpCode, HttpStatus, Param, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RequireSiteMatch, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { TalentJourneyReadService } from './talent-journey-read.service.js';
import type { TalentRequisitionJourney } from './dto/talent-journey.view.js';

// Lane 2 / L2-H — the Unified Talent Journey read surface. A GET-only sub-resource of the
// pipeline episode (mirrors PipelineController `@Get(':id/history')`): the episode id anchors
// the (tenant, requisition, talent) grain the composer fans out from. Guard chain is the A2
// pattern verbatim (tenant→scope→site); read scope is `pipeline:read`. Visibility concealment
// (AUTHZ-D4b) is enforced INSIDE the composer: a non-visible / cross-tenant episode resolves
// to 404 NOT_FOUND (never 403 — existence is not disclosed), mirroring the pipeline read.
@Controller('v1/pipelines')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class TalentJourneyController {
  constructor(private readonly journey: TalentJourneyReadService) {}

  @Get(':id/journey')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pipeline:read')
  @RequireSiteMatch()
  async getJourney(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<TalentRequisitionJourney> {
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    return this.journey.getJourney({
      tenant_id: authContext.tenant_id,
      pipeline_id: id,
      visible_requisition_ids: visibleReqIds,
      requestId,
    });
  }
}
