import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { CommunicationTimelineService } from './communication-timeline.service.js';
import type { TalentCommunicationTimelineResponseDto } from './dto/communications.dto.js';

// COMM-B7 — the Talent communication timeline (Talent-owned path, per the COMM
// directive). A separate controller because the resource is talent-owned
// (`/v1/talents/{talentId}/communications`), not under the `/v1/communications`
// surface; the disposition WRITE stays on CommunicationsController. Same
// three-axis authorization (ats capability + communication:read). The read uses
// Communications associations ONLY — no Requisition/Activity join, no Activity
// projection. An unknown talent (or one with no communications) is a 200 empty
// page, never a 404.
@Controller('v1/talents')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class TalentCommunicationsController {
  constructor(private readonly timeline: CommunicationTimelineService) {}

  @Get(':talentId/communications')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('communication:read')
  async list(
    @Param('talentId', ParseUUIDPipe) talentId: string,
    @Query('limit') limit: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<TalentCommunicationTimelineResponseDto> {
    return this.timeline.getTalentTimeline(auth.tenant_id, talentId, { limit, cursor }, requestId);
  }
}
