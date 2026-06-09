import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
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

import type { CreateTaskRequestDto } from './dto/create-task-request.dto.js';
import { isTaskOwnerType, type TaskOwnerType } from './dto/task-owner-type.js';
import { isTaskStatus, type TaskStatus } from './dto/task-status.js';
import type { TaskView } from './dto/task.view.js';
import type { UpdateTaskRequestDto } from './dto/update-task-request.dto.js';
import {
  TASK_ASSIGNEE_VALIDATOR,
  type TaskAssigneeValidator,
} from './task-assignee.port.js';
import {
  isOwnerVisible,
  TaskRepository,
  type TaskVisibilityInputs,
} from './task.repository.js';

// TaskController — Tasks backend (the last core recruiter surface).
//
// Guard chain (the ATS pattern, verbatim):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('ats')           // class — tenant axis
//   @RequireScopes('task:read'|'task:write')  // route — scope axis
//   @RequireSiteMatch()                 // route — site axis
//
// Visibility (the load-bearing discipline): every read ANDs the linked-entity
// visibility via the libs/visibility resolvers (resolved from the request,
// attached by the global VisibilityInterceptor). Create asserts the owner is
// visible (404 if not — the engagement precedent). The assignee is validated
// active-within-tenant via the port (cross-tenant/inactive → 422).
@Controller('v1/tasks')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class TaskController {
  constructor(
    private readonly repo: TaskRepository,
    @Inject(TASK_ASSIGNEE_VALIDATOR)
    private readonly assignee: TaskAssigneeValidator,
  ) {}

  // GET /v1/tasks
  //   - ?owner_type&owner_id → by-entity (tasks on an entity; default all
  //     statuses).
  //   - else                 → my-tasks (assignee = actor; default open),
  //     due-date-sorted.
  // ?status=open|done|all narrows (all = no filter).
  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('task:read')
  @RequireSiteMatch()
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('owner_type') ownerType: string | undefined,
    @Query('owner_id') ownerId: string | undefined,
    @Query('status') statusQuery: string | undefined,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<{ items: TaskView[] }> {
    const vis = await this.resolveVis(req);
    const statusFilter = this.parseStatus(statusQuery, requestId);

    if (ownerType !== undefined || ownerId !== undefined) {
      if (ownerType === undefined || ownerId === undefined) {
        throw new AramoError(
          'VALIDATION_ERROR',
          'owner_type and owner_id must both be present for a by-entity list',
          422,
          { requestId, details: { owner_type: ownerType, owner_id: ownerId } },
        );
      }
      if (!isTaskOwnerType(ownerType)) {
        throw new AramoError(
          'VALIDATION_ERROR',
          `Invalid owner_type '${ownerType}'`,
          422,
          { requestId, details: { owner_type: ownerType } },
        );
      }
      const items = await this.repo.listForOwner({
        tenant_id: authContext.tenant_id,
        owner_type: ownerType as TaskOwnerType,
        owner_id: ownerId,
        ...(statusFilter === undefined ? {} : { status: statusFilter }),
        vis,
      });
      return { items };
    }

    // my-tasks — default status 'open' when the caller doesn't specify.
    const myStatus = statusQuery === undefined ? 'open' : statusFilter;
    const items = await this.repo.listForAssignee({
      tenant_id: authContext.tenant_id,
      assignee_id: authContext.sub,
      ...(myStatus === undefined ? {} : { status: myStatus }),
      vis,
    });
    return { items };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('task:read')
  @RequireSiteMatch()
  async get(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<TaskView> {
    const vis = await this.resolveVis(req);
    const view = await this.repo.findByIdForActor({
      tenant_id: authContext.tenant_id,
      id,
      vis,
    });
    if (view === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Task not found in tenant (or not visible to actor)',
        404,
        { requestId, details: { id } },
      );
    }
    return view;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('task:write')
  @RequireSiteMatch()
  async create(
    @AuthContext() authContext: AuthContextType,
    @Body() body: CreateTaskRequestDto,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<TaskView> {
    if (typeof body.title !== 'string' || body.title.trim() === '') {
      throw new AramoError('VALIDATION_ERROR', 'title is required', 422, {
        requestId,
        details: { field: 'title' },
      });
    }
    if (!isTaskOwnerType(body.owner_type)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `Invalid owner_type '${String(body.owner_type)}'`,
        422,
        { requestId, details: { field: 'owner_type' } },
      );
    }
    if (typeof body.owner_id !== 'string' || body.owner_id === '') {
      throw new AramoError('VALIDATION_ERROR', 'owner_id is required', 422, {
        requestId,
        details: { field: 'owner_id' },
      });
    }

    // Create-time link-target assert (the engagement precedent) — 404 if the
    // owner entity is not visible to the actor (non-leak; never confirms the
    // entity exists).
    const vis = await this.resolveVis(req);
    if (!isOwnerVisible(body.owner_type, body.owner_id, vis)) {
      throw new AramoError(
        'NOT_FOUND',
        'Task owner not found in tenant (or not visible to actor)',
        404,
        {
          requestId,
          details: { owner_type: body.owner_type, owner_id: body.owner_id },
        },
      );
    }

    if (body.assignee_id !== undefined) {
      await this.assertAssignee(authContext.tenant_id, body.assignee_id, requestId);
    }

    return this.repo.create({
      tenant_id: authContext.tenant_id,
      created_by_user_id: authContext.sub,
      input: body,
    });
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('task:write')
  @RequireSiteMatch()
  async update(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: UpdateTaskRequestDto,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<TaskView> {
    if (body.status !== undefined && !isTaskStatus(body.status)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `Invalid status '${String(body.status)}'`,
        422,
        { requestId, details: { field: 'status' } },
      );
    }
    // The task's owner must remain visible to mutate (404 otherwise). owner is
    // immutable (R6) — the DTO carries no owner fields by construction.
    const vis = await this.resolveVis(req);
    const existing = await this.repo.findByIdForActor({
      tenant_id: authContext.tenant_id,
      id,
      vis,
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Task not found in tenant (or not visible to actor)',
        404,
        { requestId, details: { id } },
      );
    }
    // Reassign → re-validate (null clears the assignee, no validation).
    if (body.assignee_id !== undefined && body.assignee_id !== null) {
      await this.assertAssignee(authContext.tenant_id, body.assignee_id, requestId);
    }
    return this.repo.update({
      tenant_id: authContext.tenant_id,
      id,
      input: body,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('task:write')
  @RequireSiteMatch()
  async delete(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<void> {
    const vis = await this.resolveVis(req);
    const existing = await this.repo.findByIdForActor({
      tenant_id: authContext.tenant_id,
      id,
      vis,
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Task not found in tenant (or not visible to actor)',
        404,
        { requestId, details: { id } },
      );
    }
    await this.repo.delete({ id });
  }

  // ---- helpers ----

  private async resolveVis(req: Request): Promise<TaskVisibilityInputs> {
    const visibility = await req.resolveVisibility!();
    const visible_requisition_ids = await req.resolveVisibleRequisitionIds!();
    const visible_contact_ids = await req.resolveVisibleContactIds!();
    return { visibility, visible_requisition_ids, visible_contact_ids };
  }

  private parseStatus(
    statusQuery: string | undefined,
    requestId: string,
  ): TaskStatus | undefined {
    if (statusQuery === undefined || statusQuery === 'all') return undefined;
    if (!isTaskStatus(statusQuery)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `Invalid status filter '${statusQuery}' (expected open|done|all)`,
        422,
        { requestId, details: { status: statusQuery } },
      );
    }
    return statusQuery;
  }

  private async assertAssignee(
    tenant_id: string,
    user_id: string,
    requestId: string,
  ): Promise<void> {
    const ok = await this.assignee.isActiveTenantMember({ tenant_id, user_id });
    if (!ok) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'assignee must be an active user in this tenant',
        422,
        {
          requestId,
          details: {
            reason: 'assignee_not_active_tenant_member',
            assignee_id: user_id,
          },
        },
      );
    }
  }
}
