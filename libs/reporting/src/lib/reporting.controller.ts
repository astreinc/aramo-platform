import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import {
  RequireScopes,
  RequireSiteMatch,
  RolesGuard,
} from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import type {
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
  ): Promise<TenantCountsReportView> {
    return this.reportingService.getTenantCounts({
      tenant_id: authContext.tenant_id,
      user_id: authContext.sub,
      scopes: authContext.scopes,
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
  ): Promise<RequisitionStatusRollupView> {
    return this.reportingService.getRequisitionRollup({
      tenant_id: authContext.tenant_id,
      user_id: authContext.sub,
      scopes: authContext.scopes,
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
  ): Promise<PipelineStageRollupView> {
    return this.reportingService.getPipelineRollup({
      tenant_id: authContext.tenant_id,
      user_id: authContext.sub,
      scopes: authContext.scopes,
      ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
    });
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
  ): Promise<PlacementCountReportView> {
    return this.reportingService.getPlacementCount({
      tenant_id: authContext.tenant_id,
      user_id: authContext.sub,
      scopes: authContext.scopes,
      ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
    });
  }
}
