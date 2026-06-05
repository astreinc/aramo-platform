import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import {
  RequireScopes,
  RequireSiteMatch,
  RolesGuard,
} from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import type { CreatePipelineRequestDto } from './dto/create-pipeline-request.dto.js';
import type { PipelineStatusHistoryView } from './dto/pipeline-status-history.view.js';
import type { PipelineView } from './dto/pipeline.view.js';
import type { TransitionPipelineRequestDto } from './dto/transition-pipeline-request.dto.js';
import { PipelineRepository } from './pipeline.repository.js';

// PipelineController — PR-A5a Gate 5 ATS Batch 4a (the state machine).
//
// Guard chain (A2 pattern, verbatim):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('ats')           // class-level — tenant axis
//   @RequireScopes(...)                 // route-level — scope axis
//   @RequireSiteMatch()                 // route-level — site axis
//
// === Scope gating (HK-IDENT-SCOPES — proper scopes seeded) ===
// Seeded catalog (recruiter+ unless noted):
//   - pipeline:read (HK-IDENT-SCOPES)
//   - pipeline:add
//   - pipeline:change-status   ← THE transition scope
//   - pipeline:add-activity
//   - pipeline:remove (tenant_admin only)
//
// Read routes (list/get/history) now key on the proper `pipeline:read`
// scope, replacing the A5a `pipeline:add` superset expedient.
@Controller('v1/pipelines')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class PipelineController {
  constructor(private readonly pipelineRepository: PipelineRepository) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pipeline:read')
  @RequireSiteMatch()
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('requisition_id') requisitionId: string | undefined,
    @Query('talent_record_id') talentRecordId: string | undefined,
    @Req() req: Request,
  ): Promise<{ items: PipelineView[] }> {
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const items = await this.pipelineRepository.listForActor({
      tenant_id: authContext.tenant_id,
      visible_requisition_ids: visibleReqIds,
      ...(requisitionId === undefined ? {} : { requisition_id: requisitionId }),
      ...(talentRecordId === undefined
        ? {}
        : { talent_record_id: talentRecordId }),
    });
    return { items };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pipeline:read')
  @RequireSiteMatch()
  async get(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<PipelineView> {
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const view = await this.pipelineRepository.findByIdForActor({
      tenant_id: authContext.tenant_id,
      id,
      visible_requisition_ids: visibleReqIds,
    });
    if (view === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Pipeline not found in tenant (or not visible to actor)',
        404,
        { requestId, details: { id } },
      );
    }
    return view;
  }

  @Get(':id/history')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pipeline:read')
  @RequireSiteMatch()
  async listHistory(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
  ): Promise<{ items: PipelineStatusHistoryView[] }> {
    const items = await this.pipelineRepository.listHistory({
      tenant_id: authContext.tenant_id,
      pipeline_id: id,
    });
    return { items };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('pipeline:add')
  @RequireSiteMatch()
  async create(
    @AuthContext() authContext: AuthContextType,
    @Body() body: CreatePipelineRequestDto,
  ): Promise<PipelineView> {
    return this.pipelineRepository.create({
      tenant_id: authContext.tenant_id,
      input: body,
    });
  }

  @Post(':id/transition')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pipeline:change-status')
  @RequireSiteMatch()
  async transition(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: TransitionPipelineRequestDto,
    @RequestId() requestId: string,
  ): Promise<PipelineView> {
    return this.pipelineRepository.transition({
      tenant_id: authContext.tenant_id,
      id,
      to_status: body.to_status,
      changed_by_id: authContext.sub,
      ...(body.note === undefined ? {} : { note: body.note }),
      requestId,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('pipeline:remove')
  @RequireSiteMatch()
  async delete(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<void> {
    await this.pipelineRepository.delete({
      tenant_id: authContext.tenant_id,
      id,
      requestId,
    });
  }
}
