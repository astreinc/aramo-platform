import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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

import type { AssignRequisitionRequestDto } from './dto/assign-requisition-request.dto.js';
import type { CreateRequisitionRequestDto } from './dto/create-requisition-request.dto.js';
import type { RequisitionAssignmentView } from './dto/requisition-assignment.view.js';
import type { RequisitionView } from './dto/requisition.view.js';
import type { UpdateRequisitionRequestDto } from './dto/update-requisition-request.dto.js';
import { RequisitionAssignmentRepository } from './requisition-assignment.repository.js';
import { RequisitionRepository } from './requisition.repository.js';

// RequisitionController — PR-A3 Gate 5 ATS Batch 2.
//
// Guard chain (A2 pattern, verbatim):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('ats')           // class-level — tenant axis
//   @RequireScopes('requisition:...')   // route-level — scope axis
//   @RequireSiteMatch()                 // route-level — site axis
//
// === The visibility filter (directive Ruling 2) ===
// The GUARD CHAIN does NOT distinguish recruiter from tenant_admin —
// both pass @RequireScopes('requisition:read'). The visibility filter
// runs INSIDE the controller/repository (RequisitionRepository.
// listForActor / findByIdForActor) by reading AuthContext.scopes:
//   - scopes ∋ 'requisition:read:all' → no filter
//   - scopes ∌ 'requisition:read:all' → AND assignments.some.user_id = sub
// A recruiter requesting an unassigned requisition by id → 404 (not in
// the visible set), NEVER 403 (they hold the scope).
//
// === Assign/unassign gating (directive Ruling 3 + §1 catalog gap) ===
// The seeded scope catalog has no `requisition:assign`. We require BOTH
// `requisition:edit` AND `requisition:delete` on the assign + unassign
// routes — RolesGuard enforces SUPERSET, so a recruiter (who has `:edit`
// but not `:delete`) is rejected, and only tenant_admin (who has both)
// can call them. This composes existing seeded scopes to express the
// tenant_admin tier; no new scope is added at the identity layer.
@Controller('v1/requisitions')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class RequisitionController {
  constructor(
    private readonly requisitionRepository: RequisitionRepository,
    private readonly assignmentRepository: RequisitionAssignmentRepository,
  ) {}

  // -------------------------------------------------------------------------
  // CRUD routes — recruiter divergence: delete → tenant_admin only
  // -------------------------------------------------------------------------

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('requisition:read')
  @RequireSiteMatch()
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('site_id') siteIdFromQuery: string | undefined,
  ): Promise<{ items: RequisitionView[] }> {
    const items = await this.requisitionRepository.listForActor({
      tenant_id: authContext.tenant_id,
      actor_scopes: authContext.scopes,
      actor_user_id: authContext.sub,
      site_id: siteIdFromQuery,
    });
    return { items };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('requisition:read')
  @RequireSiteMatch()
  async get(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<RequisitionView> {
    const view = await this.requisitionRepository.findByIdForActor({
      tenant_id: authContext.tenant_id,
      id,
      actor_scopes: authContext.scopes,
      actor_user_id: authContext.sub,
    });
    if (view === null) {
      // Ruling 2: 404 (not in visible set) regardless of whether the
      // row genuinely does not exist or is invisible to the recruiter.
      // NEVER 403 here — the scope passed.
      throw new AramoError(
        'NOT_FOUND',
        'Requisition not found in tenant (or not visible to actor)',
        404,
        { requestId, details: { id } },
      );
    }
    return view;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('requisition:create')
  @RequireSiteMatch()
  async create(
    @AuthContext() authContext: AuthContextType,
    @Body() body: CreateRequisitionRequestDto,
  ): Promise<RequisitionView> {
    return this.requisitionRepository.create({
      tenant_id: authContext.tenant_id,
      entered_by_id: authContext.sub,
      input: body,
    });
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('requisition:edit')
  @RequireSiteMatch()
  async update(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: UpdateRequisitionRequestDto,
    @RequestId() requestId: string,
  ): Promise<RequisitionView> {
    return this.requisitionRepository.update({
      tenant_id: authContext.tenant_id,
      id,
      input: body,
      requestId,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('requisition:delete')
  @RequireSiteMatch()
  async delete(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<void> {
    await this.requisitionRepository.delete({
      tenant_id: authContext.tenant_id,
      id,
      requestId,
    });
  }

  // -------------------------------------------------------------------------
  // Assign/unassign routes — tenant_admin tier (Ruling 3 + catalog gap)
  // -------------------------------------------------------------------------

  @Get(':id/assignments')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('requisition:read', 'requisition:read:all')
  @RequireSiteMatch()
  async listAssignments(
    @AuthContext() authContext: AuthContextType,
    @Param('id') requisitionId: string,
  ): Promise<{ items: RequisitionAssignmentView[] }> {
    // tenant_admin-gated read (requires :read AND :read:all → SUPERSET
    // refusal for recruiters who only hold :read). Mirrors the assign
    // mutation's tier; admin-only visibility into the assignment join.
    const items = await this.assignmentRepository.listForRequisition({
      tenant_id: authContext.tenant_id,
      requisition_id: requisitionId,
    });
    return { items };
  }

  @Post(':id/assignments')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('requisition:edit', 'requisition:delete')
  @RequireSiteMatch()
  async assign(
    @AuthContext() authContext: AuthContextType,
    @Param('id') requisitionId: string,
    @Body() body: AssignRequisitionRequestDto,
    @RequestId() requestId: string,
  ): Promise<RequisitionAssignmentView> {
    return this.assignmentRepository.assign({
      tenant_id: authContext.tenant_id,
      requisition_id: requisitionId,
      user_id: body.user_id,
      assigned_by_id: authContext.sub,
      requestId,
    });
  }

  @Delete(':id/assignments/:user_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('requisition:edit', 'requisition:delete')
  @RequireSiteMatch()
  async unassign(
    @AuthContext() authContext: AuthContextType,
    @Param('id') requisitionId: string,
    @Param('user_id') userId: string,
    @RequestId() requestId: string,
  ): Promise<void> {
    await this.assignmentRepository.unassign({
      tenant_id: authContext.tenant_id,
      requisition_id: requisitionId,
      user_id: userId,
      requestId,
    });
  }
}
