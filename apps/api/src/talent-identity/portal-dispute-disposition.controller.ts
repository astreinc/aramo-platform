import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { TalentTrustService } from '@aramo/talent-trust';

import {
  PortalDisputeDisposeDto,
  PortalDisputeRequestInfoDto,
  type PortalDisputeDispositionResultDto,
  type PortalDisputeTenantDetailDto,
  type PortalDisputeTenantListDto,
} from './dto/portal-dispute-disposition.dto.js';

// Portal P3b (§PR-2 + Amendment v1.2) — the TENANT-side dispute-DISPOSITION
// surface. Distinct from the evidence-keyed DisputeResolutionController: this acts
// on the talent-raised PortalDispute (the tenant's subject-keyed work items),
// wiring each disposition to TR-15 through the ratified §2 map. PROPOSE/DISPOSE:
// the talent proposes (P3a), the human here disposes. `identity:resolve`-gated
// (the same privileged tenant scope as the contradiction/advisory surfaces);
// tenant_id + actor come ONLY from the JWT.
//
//   triage       → trust.dispute() per work item → UNDER_REVIEW (W-1)
//   request-info → a recorded TENANT note; stays UNDER_REVIEW
//   correct      → resolveDispute('upheld')   → item REVOKED (RESOLVED_CORRECTED)
//   uphold       → resolveDispute('rejected') → item VALID   (RESOLVED_UPHELD)
//   extend       → the single +15d reinvestigation extension (ruling 5)
@Controller('v1/talent/identity/portal-disputes')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class PortalDisputeDispositionController {
  constructor(private readonly trust: TalentTrustService) {}

  // GET / — the tenant's dispute worklist (open by default; ?all=1 for history).
  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('all') all: string | undefined,
  ): Promise<PortalDisputeTenantListDto> {
    const items = await this.trust.listTenantDisputeWorkItems(authContext.tenant_id, {
      open: all !== '1',
      limit: 200,
    });
    return {
      disputes: items.map((wi) => ({
        dispute_id: wi.dispute_id,
        subject_id: wi.subject_id,
        item_type: wi.item_type,
        status: wi.status,
        arrived_at: wi.created_at.toISOString(),
      })),
    };
  }

  // GET /:id — one dispute the tenant holds a work item for (uniform 404 else).
  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async detail(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PortalDisputeTenantDetailDto> {
    const { dispute, workItems, statements } = await this.trust.getTenantDispute({
      tenantId: authContext.tenant_id,
      disputeId: id,
      requestId,
    });
    return {
      dispute_id: dispute.id,
      item_type: dispute.item_type,
      status: dispute.status,
      opened_at: dispute.opened_at.toISOString(),
      resolution_note: dispute.resolution_note,
      triage_due_at: dispute.triage_due_at.toISOString(),
      reinvestigation_due_at: dispute.reinvestigation_due_at.toISOString(),
      statements: statements.map((s) => ({
        author: s.author,
        statement: s.statement,
        created_at: s.created_at.toISOString(),
      })),
      work_items: workItems.map((wi) => ({
        subject_id: wi.subject_id,
        status: wi.status,
        no_transition_reason: wi.no_transition_reason,
      })),
    };
  }

  @Post(':id/triage')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async triage(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PortalDisputeDispositionResultDto> {
    const dispute = await this.trust.triagePortalDispute({
      tenantId: authContext.tenant_id,
      disputeId: id,
      actor: authContext.sub,
      requestId,
    });
    return { dispute_id: dispute.id, status: dispute.status };
  }

  @Post(':id/request-info')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async requestInfo(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PortalDisputeRequestInfoDto,
  ): Promise<PortalDisputeDispositionResultDto> {
    const dispute = await this.trust.requestInfoPortalDispute({
      tenantId: authContext.tenant_id,
      disputeId: id,
      note: body.note,
      requestId,
    });
    return { dispute_id: dispute.id, status: dispute.status };
  }

  @Post(':id/correct')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async correct(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PortalDisputeDisposeDto,
  ): Promise<PortalDisputeDispositionResultDto> {
    const dispute = await this.trust.disposePortalDispute({
      tenantId: authContext.tenant_id,
      disputeId: id,
      outcome: 'RESOLVED_CORRECTED',
      note: body.note,
      actor: authContext.sub,
      requestId,
    });
    return { dispute_id: dispute.id, status: dispute.status };
  }

  @Post(':id/uphold')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async uphold(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PortalDisputeDisposeDto,
  ): Promise<PortalDisputeDispositionResultDto> {
    const dispute = await this.trust.disposePortalDispute({
      tenantId: authContext.tenant_id,
      disputeId: id,
      outcome: 'RESOLVED_UPHELD',
      note: body.note,
      actor: authContext.sub,
      requestId,
    });
    return { dispute_id: dispute.id, status: dispute.status };
  }

  @Post(':id/extend')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async extend(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PortalDisputeDispositionResultDto> {
    const dispute = await this.trust.extendPortalDisputeReinvestigation({
      tenantId: authContext.tenant_id,
      disputeId: id,
      now: new Date(),
      requestId,
    });
    return { dispute_id: dispute.id, status: dispute.status };
  }
}
