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
import type {
  ConfirmProfileRequestDto,
  ConfirmProfileResponseDto,
  DraftProfileRequestDto,
  DraftProfileResponseDto,
} from './dto/profile-generation.dto.js';
import type { RequisitionAssignmentView } from './dto/requisition-assignment.view.js';
import type { RequisitionProfileView } from './dto/requisition-profile.view.js';
import type { RequisitionView } from './dto/requisition.view.js';
import type { UpdateRequisitionRequestDto } from './dto/update-requisition-request.dto.js';
import { RequisitionAssignmentRepository } from './requisition-assignment.repository.js';
import { RequisitionProfileService } from './requisition-profile.service.js';
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
    private readonly profileService: RequisitionProfileService,
  ) {}

  // -------------------------------------------------------------------------
  // CRUD routes — recruiter divergence: delete → tenant_admin only
  // -------------------------------------------------------------------------

  // Search PR-1 — the LIST route gates on requisition:read (route-static).
  // The optional ?q= quick-search ADDITIONALLY requires requisition:search
  // WHEN q is present; the no-q LIST keeps its requisition:read-only gate.
  // The trigram (title) filter ANDs with the A3-OR-D4b visibility predicate
  // (and any company_id narrowing) — NARROWS within the visible set, never
  // widens.
  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('requisition:read')
  @RequireSiteMatch()
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @Query('company_id') companyIdFromQuery: string | undefined,
    @Query('q') q: string | undefined,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<{ items: RequisitionView[] }> {
    const searchTerm = q?.trim() ? q.trim() : undefined;
    if (searchTerm !== undefined && !authContext.scopes.includes('requisition:search')) {
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        'requisition:search scope required for ?q= quick-search',
        403,
        { requestId, details: { reason: 'search_scope_missing', required_scope: 'requisition:search' } },
      );
    }
    const visibility = await req.resolveVisibility!();
    const items = await this.requisitionRepository.listForActor({
      tenant_id: authContext.tenant_id,
      visibility,
      site_id: siteIdFromQuery,
      company_id: companyIdFromQuery,
      q: searchTerm,
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

  // PR-A1 Requisition-Gating Rework — the PATCH route carries NO route-level
  // @RequireScopes guard. RolesGuard is all-or-nothing AND, so it cannot
  // express the "requisition:edit OR requisition:edit:status" disjunction the
  // status-only tier requires. Authorization is enforced IN-SERVICE by the
  // status-only edit gate at RequisitionRepository.update (mirrors the
  // comp/financial edit-gate's safe-by-construction repository-boundary
  // pattern): a full editor (requisition:edit) edits everything; a
  // status-only holder (requisition:edit:status, no :edit) may write only
  // the status field; a caller with neither is rejected 403. @RequireSiteMatch
  // + the class-level JwtAuthGuard/EntitlementGuard('ats')/RolesGuard chain
  // are unchanged.
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
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
  // AI JD + GoldenProfile generation (Job-Module LB-3 / ADR-0015 v1.2)
  // -------------------------------------------------------------------------
  //
  // The draft → confirm human-in-the-loop split (mirrors the engagement
  // draft/send pattern). DRAFT runs the LLM (G4 allowlisted prompt) + returns the
  // generated JD + structured GoldenProfile WITHOUT committing anything.
  // CONFIRM persists the recruiter-reviewed final via the seam mint
  // (creates Job + GoldenProfile, stamps golden_profile_id). NO consent gate
  // (G3 — no external recipient). Visibility-scoped: a req invisible to the
  // actor → 404.
  //
  // PR-A1 Requisition-Gating Rework — RE-GATED off requisition:edit onto the
  // dedicated requisition:profile:generate scope (#226 originally treated
  // generation as a requisition:edit affordance; the rework separates it so
  // base recruiter — now read-only on requisitions — does NOT generate, while
  // the 5-role management tier does). Both endpoints require
  // requisition:profile:generate.

  // PR-A2 P3 — the first-class profile READ (A1 deferred it). Gated on
  // requisition:read (NOT profile:generate): reading the profile is a broad
  // affordance — anyone who can read the requisition sees its profile. The
  // generate/edit affordances stay on the 5-role tier (profile:generate /
  // profile:edit) enforced at the FE workbench + the write endpoints below.
  // Visibility-scoped in-service (404 on an invisible req); the profile-less
  // requisition returns the empty-shaped DTO, never a 404/500.
  @Get(':id/profile')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('requisition:read')
  @RequireSiteMatch()
  async getProfile(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<RequisitionProfileView> {
    const visibility = await req.resolveVisibility!();
    return this.profileService.readProfile({
      tenant_id: authContext.tenant_id,
      requisition_id: id,
      visibility,
      requestId,
    });
  }

  @Post(':id/profile/draft')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('requisition:profile:generate')
  @RequireSiteMatch()
  async draftProfile(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: DraftProfileRequestDto,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<DraftProfileResponseDto> {
    const visibility = await req.resolveVisibility!();
    return this.profileService.draftProfile({
      tenant_id: authContext.tenant_id,
      requisition_id: id,
      brief: body.brief,
      ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
      visibility,
      requestId,
    });
  }

  @Post(':id/profile/confirm')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('requisition:profile:generate')
  @RequireSiteMatch()
  async confirmProfile(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: ConfirmProfileRequestDto,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<ConfirmProfileResponseDto> {
    const visibility = await req.resolveVisibility!();
    return this.profileService.confirmProfile({
      tenant_id: authContext.tenant_id,
      requisition_id: id,
      ...(body.draft_event_id !== undefined ? { draft_event_id: body.draft_event_id } : {}),
      jd_text: body.jd_text,
      golden_profile: body.golden_profile,
      visibility,
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
