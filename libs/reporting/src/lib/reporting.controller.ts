import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import {
  RequireScopes,
  RequireSiteMatch,
  RolesGuard,
} from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import type {
  CompanyMetricsReportView,
  CompanyPlacementsReportView,
  PipelineStageRollupView,
  PlacementCountReportView,
  RequisitionStatusRollupView,
  TenantCountsReportView,
} from './dto/report.view.js';
import { ReportingService } from './reporting.service.js';

// ReportingController — PR-A7 Gate 5 — ATS-INTERNAL read aggregator.
//
// Guard chain (A2 pattern, verbatim):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('ats')           // class-level — tenant axis
//   @RequireScopes(...)                 // route-level — scope axis
//   @RequireSiteMatch()                 // route-level — site axis
//
// Scope (NOT seeded — gap-and-note per A7 directive §1):
//   - `report:read` — read-only (recruiter+ AND tenant_admin; the
//     role-visibility predicate at the service layer governs what
//     each role sees, NOT a separate `:all` scope here).
//
// A7's HARD EXCLUSIONS (every refused metric here):
//   - submittal rollups (Core engagement schema; T5, M6).
//   - match / tier / judgment / examination metrics (Core; R10).
//   - EEO reporting (A4-deferred fields; compliance-scoped).
//   - PDF/FPDF rendering (presentation; defer).
@Controller('v1/reports')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class ReportingController {
  constructor(private readonly reportingService: ReportingService) {}

  @Get('tenant-counts')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('report:read')
  @RequireSiteMatch()
  async tenantCounts(
    @AuthContext() authContext: AuthContextType,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @Req() req: Request,
  ): Promise<TenantCountsReportView> {
    const visibility = await req.resolveVisibility!();
    return this.reportingService.getTenantCounts({
      tenant_id: authContext.tenant_id,
      user_id: authContext.sub,
      scopes: authContext.scopes,
      visibility,
      ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
    });
  }

  @Get('requisition-rollup')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('report:read')
  @RequireSiteMatch()
  async requisitionRollup(
    @AuthContext() authContext: AuthContextType,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @Req() req: Request,
  ): Promise<RequisitionStatusRollupView> {
    const visibility = await req.resolveVisibility!();
    return this.reportingService.getRequisitionRollup({
      tenant_id: authContext.tenant_id,
      user_id: authContext.sub,
      scopes: authContext.scopes,
      visibility,
      ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
    });
  }

  @Get('pipeline-rollup')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('report:read')
  @RequireSiteMatch()
  async pipelineRollup(
    @AuthContext() authContext: AuthContextType,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @Req() req: Request,
  ): Promise<PipelineStageRollupView> {
    const visibility = await req.resolveVisibility!();
    return this.reportingService.getPipelineRollup({
      tenant_id: authContext.tenant_id,
      user_id: authContext.sub,
      scopes: authContext.scopes,
      visibility,
      ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
    });
  }

  // Per-company metrics — open reqs / placements / submitted / fill-rate for the
  // company ids in ?company_ids=a,b,c (visibility-scoped). Powers the companies
  // list columns + drawer + account-hub KPI strip. report:read (same gate as the
  // other rollups). Empty / missing ids → empty items.
  @Get('company-metrics')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('report:read')
  @RequireSiteMatch()
  async companyMetrics(
    @AuthContext() authContext: AuthContextType,
    @Query('company_ids') companyIdsCsv: string | undefined,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @Req() req: Request,
  ): Promise<CompanyMetricsReportView> {
    const companyIds =
      companyIdsCsv === undefined || companyIdsCsv.trim() === ''
        ? []
        : companyIdsCsv.split(',').map((s) => s.trim()).filter((s) => s !== '');
    const visibility = await req.resolveVisibility!();
    const items = await this.reportingService.getCompanyMetrics(
      {
        tenant_id: authContext.tenant_id,
        user_id: authContext.sub,
        scopes: authContext.scopes,
        visibility,
        ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
      },
      companyIds,
    );
    return { items };
  }

  // Per-company placements — placed pipelines at a company's visible reqs
  // (account-hub Placements tab). report:read; visibility-scoped.
  @Get('company-placements')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('report:read')
  @RequireSiteMatch()
  async companyPlacements(
    @AuthContext() authContext: AuthContextType,
    @Query('company_id') companyId: string | undefined,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @Req() req: Request,
  ): Promise<CompanyPlacementsReportView> {
    if (companyId === undefined || companyId.trim() === '') {
      return { items: [] };
    }
    const visibility = await req.resolveVisibility!();
    const items = await this.reportingService.getCompanyPlacements(
      {
        tenant_id: authContext.tenant_id,
        user_id: authContext.sub,
        scopes: authContext.scopes,
        visibility,
        ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
      },
      companyId.trim(),
    );
    return { items };
  }

  // Note: returns the ATS-INTERNAL placed-pipeline count. The Core
  // submittal-confirmed placement count is NOT computed (the seam
  // exclusion; see ReportingService).
  @Get('placement-count')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('report:read')
  @RequireSiteMatch()
  async placementCount(
    @AuthContext() authContext: AuthContextType,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @Req() req: Request,
  ): Promise<PlacementCountReportView> {
    const visibility = await req.resolveVisibility!();
    return this.reportingService.getPlacementCount({
      tenant_id: authContext.tenant_id,
      user_id: authContext.sub,
      scopes: authContext.scopes,
      visibility,
      ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
    });
  }
}
