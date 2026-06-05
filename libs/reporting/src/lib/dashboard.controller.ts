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

import type { DashboardView } from './dto/report.view.js';
import { ReportingService } from './reporting.service.js';

// DashboardController — PR-A7 Gate 5 — ATS-INTERNAL composition route.
//
// One route: GET /v1/dashboard. Bundles the in-scope metrics
// (tenant counts + requisition rollup + pipeline rollup + ATS-internal
// placement count + upcoming calendar events + recent activity) into a
// single payload so a recruiter UI does not have to N-round-trip on
// load. Scope-gated on `dashboard:read` (NOT seeded — gap-and-note).
//
// The composition reuses ReportingService — every byte returned is
// from an ATS-side schema. NO Core / submittal / engagement /
// examination row is read.
@Controller('v1/dashboard')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class DashboardController {
  constructor(private readonly reportingService: ReportingService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('dashboard:read')
  @RequireSiteMatch()
  async get(
    @AuthContext() authContext: AuthContextType,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @Req() req: Request,
  ): Promise<DashboardView> {
    const visibility = await req.resolveVisibility!();
    return this.reportingService.getDashboard({
      tenant_id: authContext.tenant_id,
      user_id: authContext.sub,
      scopes: authContext.scopes,
      visibility,
      ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
    });
  }
}
