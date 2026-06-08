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

import { validateCompensationInput } from './compensation-validation.js';
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
// === Assign/unassign gating (HK-IDENT-SCOPES — proper scope) ===
// Gated on `requisition:assign` (tenant_admin only). Replaces the prior
// A3 superset expedients (edit+delete for POST/DELETE; read+read:all for
// GET) now that the proper scope is seeded.
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
    @Req() req: Request,
  ): Promise<{ items: RequisitionView[] }> {
    const visibility = await req.resolveVisibility!();
    const items = await this.requisitionRepository.listForActor({
      tenant_id: authContext.tenant_id,
      visibility,
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
    @Req() req: Request,
  ): Promise<RequisitionView> {
    const visibility = await req.resolveVisibility!();
    const view = await this.requisitionRepository.findByIdForActor({
      tenant_id: authContext.tenant_id,
      id,
      visibility,
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
    @RequestId() requestId: string,
  ): Promise<RequisitionView> {
    // v1.1 §2.3 closed-set guards (ISO-4217 + rate period + comp
    // model + Decimal-string shape). Throws AramoError VALIDATION_ERROR
    // (400) on miss — never reaches the repository layer.
    validateCompensationInput(body, requestId);
    // D-AUTHZ-COMP-WRITE-1 — the WRITE-side floor lives at the
    // repository (the deepest layer all 3 write paths traverse); the
    // controller threads the AuthContext.scopes through. The gate
    // rejects 403 BEFORE any DB write or audit emission.
    return this.requisitionRepository.create({
      tenant_id: authContext.tenant_id,
      entered_by_id: authContext.sub,
      input: body,
      scopes: authContext.scopes,
      requestId,
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
    validateCompensationInput(body, requestId);
    return this.requisitionRepository.update({
      tenant_id: authContext.tenant_id,
      id,
      input: body,
      scopes: authContext.scopes,
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
  @RequireScopes('requisition:assign')
  @RequireSiteMatch()
  async listAssignments(
    @AuthContext() authContext: AuthContextType,
    @Param('id') requisitionId: string,
  ): Promise<{ items: RequisitionAssignmentView[] }> {
    const items = await this.assignmentRepository.listForRequisition({
      tenant_id: authContext.tenant_id,
      requisition_id: requisitionId,
    });
    return { items };
  }

  @Post(':id/assignments')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('requisition:assign')
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
  @RequireScopes('requisition:assign')
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
