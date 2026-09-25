import { Controller, Get, HttpCode, HttpStatus, Param, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RequireSiteMatch, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { RequisitionTalentBoardReadService } from './requisition-talent-board-read.service.js';
import type { RequisitionTalentBoardView } from './dto/requisition-talent-board.view.js';

// Requisition Talent Board (TB-1) — the GET-only Board read surface: a sub-resource of the
// requisition (`GET /v1/requisitions/:requisition_id/talent-board`). Guard chain is the A2
// pattern verbatim (tenant → scope → site); read scope is `pipeline:read` (G-C — no
// `submittal:read` scope exists; the Board rides the pipeline read as talent-journey does).
// Visibility concealment (AUTHZ-D4b) is enforced INSIDE the composer: a non-visible /
// cross-tenant requisition resolves to 404 (existence is not disclosed), never 403. The Board
// issues ZERO writes and composes STATE ENUMS ONLY — no compensation/bill field.
@Controller('v1/requisitions')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class RequisitionTalentBoardController {
  constructor(private readonly board: RequisitionTalentBoardReadService) {}

  @Get(':requisition_id/talent-board')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pipeline:read')
  @RequireSiteMatch()
  async getBoard(
    @AuthContext() authContext: AuthContextType,
    @Param('requisition_id') requisitionId: string,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<RequisitionTalentBoardView> {
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    return this.board.getBoard({
      tenant_id: authContext.tenant_id,
      requisition_id: requisitionId,
      visible_requisition_ids: visibleReqIds,
      now: new Date(),
      requestId,
    });
  }
}
