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
  UseGuards,
} from '@nestjs/common';
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
// === Scope gap-and-note (directive §1) ===
// The seeded scope catalog includes (recruiter+):
//   - pipeline:add
//   - pipeline:change-status   ← THE transition scope (directive §1 the
//                                naming used by the seeded catalog
//                                instead of `pipeline:transition` /
//                                `pipeline:edit`)
//   - pipeline:add-activity
// and (tenant_admin only):
//   - pipeline:remove
//
// There is NO `pipeline:read` in the seeded catalog. Per §1 gap-and-
// note, list/get are gated under `pipeline:add` — the lowest-barrier
// pipeline:* scope, on the principle that a recruiter who can add to a
// pipeline can read it. Adding a dedicated `pipeline:read` scope is
// deferred to a follow-on identity-seed amendment.
@Controller('v1/pipelines')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class PipelineController {
  constructor(private readonly pipelineRepository: PipelineRepository) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pipeline:add')
  @RequireSiteMatch()
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('requisition_id') requisitionId: string | undefined,
    @Query('talent_record_id') talentRecordId: string | undefined,
  ): Promise<{ items: PipelineView[] }> {
    const items = await this.pipelineRepository.list({
      tenant_id: authContext.tenant_id,
      ...(requisitionId === undefined ? {} : { requisition_id: requisitionId }),
      ...(talentRecordId === undefined
        ? {}
        : { talent_record_id: talentRecordId }),
    });
    return { items };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pipeline:add')
  @RequireSiteMatch()
  async get(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<PipelineView> {
    const view = await this.pipelineRepository.findById({
      tenant_id: authContext.tenant_id,
      id,
    });
    if (view === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Pipeline not found in tenant',
        404,
        { requestId, details: { id } },
      );
    }
    return view;
  }

  @Get(':id/history')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pipeline:add')
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
