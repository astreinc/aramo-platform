import {
  Body,
  Controller,
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

import type { ActivityView } from './dto/activity.view.js';
import type { CreateActivityRequestDto } from './dto/create-activity-request.dto.js';
import { ActivityRepository } from './activity.repository.js';

// ActivityController — PR-A5a Gate 5 ATS Batch 4a (sidecar to pipeline).
//
// Guard chain (A2 pattern, verbatim):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('ats')           // class-level — tenant axis
//   @RequireScopes(...)                 // route-level — scope axis
//   @RequireSiteMatch()                 // route-level — site axis
//
// === Scope gating (HK-IDENT-SCOPES — proper scopes seeded) ===
// The seeded catalog includes `activity:read` (back_office+) and now
// `activity:create` (recruiter+). The POST route keys on the proper
// `activity:create` scope, replacing the A5a `pipeline:add-activity`
// borrow.
@Controller('v1/activities')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class ActivityController {
  constructor(private readonly activityRepository: ActivityRepository) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('activity:read')
  @RequireSiteMatch()
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('subject_type') subjectType: string | undefined,
    @Query('subject_id') subjectId: string | undefined,
    @Req() req: Request,
  ): Promise<{ items: ActivityView[] }> {
    const visibility = await req.resolveVisibility!();
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const visiblePipelineIds = await req.resolveVisiblePipelineIds!();
    const items = await this.activityRepository.listForActor({
      tenant_id: authContext.tenant_id,
      visibility,
      visible_requisition_ids: visibleReqIds,
      visible_pipeline_ids: visiblePipelineIds,
      ...(subjectType === undefined ? {} : { subject_type: subjectType }),
      ...(subjectId === undefined ? {} : { subject_id: subjectId }),
    });
    return { items };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('activity:read')
  @RequireSiteMatch()
  async get(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<ActivityView> {
    const visibility = await req.resolveVisibility!();
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const visiblePipelineIds = await req.resolveVisiblePipelineIds!();
    const view = await this.activityRepository.findByIdForActor({
      tenant_id: authContext.tenant_id,
      id,
      visibility,
      visible_requisition_ids: visibleReqIds,
      visible_pipeline_ids: visiblePipelineIds,
    });
    if (view === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Activity not found in tenant (or not visible to actor)',
        404,
        { requestId, details: { id } },
      );
    }
    return view;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('activity:create')
  @RequireSiteMatch()
  async create(
    @AuthContext() authContext: AuthContextType,
    @Body() body: CreateActivityRequestDto,
  ): Promise<ActivityView> {
    return this.activityRepository.create({
      tenant_id: authContext.tenant_id,
      created_by_id: authContext.sub,
      input: body,
    });
  }
}
