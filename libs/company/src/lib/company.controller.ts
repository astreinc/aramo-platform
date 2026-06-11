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

import type { CompanyView } from './dto/company.view.js';
import type { CreateCompanyRequestDto } from './dto/create-company-request.dto.js';
import type { UpdateCompanyRequestDto } from './dto/update-company-request.dto.js';
import type { CompanyDepartmentView } from './dto/company-department.view.js';
import type { CreateCompanyDepartmentRequestDto } from './dto/create-company-department-request.dto.js';
import type { UpdateCompanyDepartmentRequestDto } from './dto/update-company-department-request.dto.js';
import { CompanyDepartmentRepository } from './company-department.repository.js';
import { CompanyRepository } from './company.repository.js';

// CompanyController — PR-A2 Gate 5 ATS Batch 1.
//
// Guard chain (Ruling 4): @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
// in that precise order. JwtAuthGuard establishes AuthContext; EntitlementGuard
// gates the TENANT capability axis (@RequireCapability('ats')); RolesGuard
// gates the SCOPE axis (@RequireScopes) AND the SITE axis (@RequireSiteMatch).
// Chain order is the pattern (PR-A1b §4 / portal precedent): unentitled
// tenants are rejected with TENANT_CAPABILITY_NOT_ENTITLED before scope
// checks ever run.
//
// Recruiter divergence (Ruling 1): delete routes require *:delete scope
// which the recruiter seed catalog deliberately omits — tenant_admin only.
// The guard rejects with INSUFFICIENT_PERMISSIONS.
//
// Site axis: @RequireSiteMatch on every route. The RolesGuard resolves
// site_id from path params (none here) or query (?site_id=...) — when a
// caller supplies one it must match AuthContext.site_id; the claim site
// must be present. Routes deliberately omit site_id from the body so the
// guard's path/query resolution governs.
//
// Tenancy: tenant_id is ALWAYS derived from AuthContext.tenant_id (never
// from the request body or query). Architecture §7.2 cross-tenant write
// defense.
@Controller('v1/companies')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class CompanyController {
  constructor(
    private readonly companyRepository: CompanyRepository,
    private readonly companyDepartmentRepository: CompanyDepartmentRepository,
  ) {}

  // ---------------------------------------------------------------------------
  // Company routes
  // ---------------------------------------------------------------------------

  // Search PR-1 — the LIST route gates on company:read (route-static). The
  // optional ?q= quick-search ADDITIONALLY requires company:search WHEN q is
  // present; the no-q LIST keeps its company:read-only gate. The trigram
  // (name) filter ANDs with the D4b visibility predicate — NARROWS within
  // the visible set, never widens.
  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('company:read')
  @RequireSiteMatch()
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @Query('q') q: string | undefined,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<{ items: CompanyView[] }> {
    const searchTerm = q?.trim() ? q.trim() : undefined;
    if (searchTerm !== undefined && !authContext.scopes.includes('company:search')) {
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        'company:search scope required for ?q= quick-search',
        403,
        { requestId, details: { reason: 'search_scope_missing', required_scope: 'company:search' } },
      );
    }
    const visibility = await req.resolveVisibility!();
    const items = await this.companyRepository.listForActor({
      tenant_id: authContext.tenant_id,
      visibility,
      site_id: siteIdFromQuery,
      q: searchTerm,
    });
    return { items };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('company:read')
  @RequireSiteMatch()
  async get(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<CompanyView> {
    const visibility = await req.resolveVisibility!();
    const view = await this.companyRepository.findByIdForActor({
      tenant_id: authContext.tenant_id,
      id,
      visibility,
    });
    if (view === null) {
      // 404 — regardless of whether the row genuinely does not exist
      // or is outside the actor's visible set (the A3 precedent —
      // never 403 for a visibility miss; the scope passed).
      throw new AramoError(
        'NOT_FOUND',
        'Company not found in tenant (or not visible to actor)',
        404,
        { requestId, details: { id } },
      );
    }
    return view;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('company:create')
  @RequireSiteMatch()
  async create(
    @AuthContext() authContext: AuthContextType,
    @Body() body: CreateCompanyRequestDto,
  ): Promise<CompanyView> {
    return this.companyRepository.create({
      tenant_id: authContext.tenant_id,
      entered_by_id: authContext.sub,
      input: body,
      // Company-Fields v1.1 — commercial fields stripped for non-holders.
      scopes: authContext.scopes,
    });
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('company:edit')
  @RequireSiteMatch()
  async update(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: UpdateCompanyRequestDto,
    @RequestId() requestId: string,
  ): Promise<CompanyView> {
    return this.companyRepository.update({
      tenant_id: authContext.tenant_id,
      id,
      input: body,
      requestId,
      // Company-Fields v1.1 — commercial fields stripped for non-holders.
      scopes: authContext.scopes,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('company:delete')
  @RequireSiteMatch()
  async delete(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<void> {
    await this.companyRepository.delete({
      tenant_id: authContext.tenant_id,
      id,
      requestId,
    });
  }

  // ---------------------------------------------------------------------------
  // CompanyDepartment routes (nested under a company)
  // ---------------------------------------------------------------------------

  @Get(':company_id/departments')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('company:read')
  @RequireSiteMatch()
  async listDepartments(
    @AuthContext() authContext: AuthContextType,
    @Param('company_id') companyId: string,
  ): Promise<{ items: CompanyDepartmentView[] }> {
    const items = await this.companyDepartmentRepository.list({
      tenant_id: authContext.tenant_id,
      company_id: companyId,
    });
    return { items };
  }

  @Post(':company_id/departments')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('company:create')
  @RequireSiteMatch()
  async createDepartment(
    @AuthContext() authContext: AuthContextType,
    @Param('company_id') companyId: string,
    @Body() body: CreateCompanyDepartmentRequestDto,
    @RequestId() requestId: string,
  ): Promise<CompanyDepartmentView> {
    return this.companyDepartmentRepository.create({
      tenant_id: authContext.tenant_id,
      company_id: companyId,
      input: body,
      requestId,
    });
  }

  @Patch(':company_id/departments/:id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('company:edit')
  @RequireSiteMatch()
  async updateDepartment(
    @AuthContext() authContext: AuthContextType,
    @Param('company_id') companyId: string,
    @Param('id') id: string,
    @Body() body: UpdateCompanyDepartmentRequestDto,
    @RequestId() requestId: string,
  ): Promise<CompanyDepartmentView> {
    return this.companyDepartmentRepository.update({
      tenant_id: authContext.tenant_id,
      company_id: companyId,
      id,
      input: body,
      requestId,
    });
  }

  @Delete(':company_id/departments/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('company:delete')
  @RequireSiteMatch()
  async deleteDepartment(
    @AuthContext() authContext: AuthContextType,
    @Param('company_id') companyId: string,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<void> {
    await this.companyDepartmentRepository.delete({
      tenant_id: authContext.tenant_id,
      company_id: companyId,
      id,
      requestId,
    });
  }
}
