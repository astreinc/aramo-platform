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
import { AramoError, RequestId } from '@aramo/common';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import type {
  AssignmentPipelineReportView,
  CompanyMetricsReportView,
  CompanyPlacementsReportView,
  FallthroughReportView,
  FillPerformanceReportView,
  GuaranteeExposureReportView,
  MarginReportView,
  PipelineStageRollupView,
  PlacementCountReportView,
  RecruiterMetricsReportView,
  RecruitingFunnelReportView,
  HiringFunnelReportView,
  SourceEffectivenessReportView,
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
// Scope (`report:read`, SEEDED to the 8 operational roles in
// libs/identity/prisma/seed.ts — T9-B5 refresh of the original gap-and-note):
//   - `report:read` — read-only (recruiter+ AND tenant_admin; the
//     role-visibility predicate at the service layer governs what
//     each role sees, NOT a separate `:all` scope here).
//
// A7's HARD EXCLUSIONS (every refused metric here):
//   - submittal rollups (Core selection schema; T5, M6).
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

  // Per-recruiter operational KPIs (My Desk header) — Submittals·wk /
  // Interviews set / Placements·MTD / Avg-time-to-submit, each with the prior-
  // period value (delta) + a recent series (sparkline) + the tenant-default
  // goal. Principal-scoped (the A3/D4b predicate inside the service). report:read.
  @Get('recruiter-metrics')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('report:read')
  @RequireSiteMatch()
  async recruiterMetrics(
    @AuthContext() authContext: AuthContextType,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @Req() req: Request,
  ): Promise<RecruiterMetricsReportView> {
    const visibility = await req.resolveVisibility!();
    const goals = await this.reportingService.getRecruiterGoals(
      authContext.tenant_id,
      authContext.sub,
    );
    const items = await this.reportingService.getRecruiterMetrics(
      {
        tenant_id: authContext.tenant_id,
        user_id: authContext.sub,
        scopes: authContext.scopes,
        visibility,
        ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
      },
      { goals },
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

  // T9-B1 — authoritative fill-rate + time-to-fill operational report.
  // Governed by Aramo-T9-B1-Directive-v1_0-LOCKED + the Gate-5 Finalization
  // Amendment. ONE combined route (D-7) returning both metrics for the cohort
  // of requisitions whose created_at ∈ [from, to). `from`/`to` are REQUIRED
  // absolute ISO instants carrying `Z` or an explicit offset (§8 / D-5);
  // date-only and zone-less values are rejected 400 (VALIDATION_ERROR — an
  // existing code; no new ErrorCode per §8). report:read + tenant/site/A3
  // (D-4) — the same guard chain as every other reporting route.
  @Get('fill-performance')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('report:read')
  @RequireSiteMatch()
  async fillPerformance(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Query('from') fromRaw: string | undefined,
    @Query('to') toRaw: string | undefined,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @Req() req: Request,
  ): Promise<FillPerformanceReportView> {
    const from = this.parseAbsoluteInstant('from', fromRaw, requestId);
    const to = this.parseAbsoluteInstant('to', toRaw, requestId);
    if (from.getTime() >= to.getTime()) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'from must be strictly before to',
        400,
        { requestId, details: { from: fromRaw, to: toRaw } },
      );
    }
    const visibility = await req.resolveVisibility!();
    return this.reportingService.getFillPerformance(
      {
        tenant_id: authContext.tenant_id,
        user_id: authContext.sub,
        scopes: authContext.scopes,
        visibility,
        ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
      },
      { from, to },
    );
  }

  // T7-P4 — authoritative guarantee-exposure summary report. Governed by
  // Aramo-T7-P4-Guarantee-Exposure-Reporting-Implementation-Directive-v1_0-LOCKED. Summary of
  // permanent-placement guarantee exposure for the cohort of PermanentPlacements whose
  // created_at (immutable activation instant) ∈ [from, to). `from`/`to` are REQUIRED absolute
  // ISO instants carrying `Z`/offset (reuses parseAbsoluteInstant); date-only/zone-less
  // rejected 400 (VALIDATION_ERROR — an existing code; no new ErrorCode). Per-currency money,
  // NO cross-currency total; summary-only, no row-level ids/PII. report:read + tenant/site/A3 —
  // the same guard chain as every other reporting route.
  @Get('guarantee-exposure')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('report:read')
  @RequireSiteMatch()
  async guaranteeExposure(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Query('from') fromRaw: string | undefined,
    @Query('to') toRaw: string | undefined,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @Req() req: Request,
  ): Promise<GuaranteeExposureReportView> {
    const from = this.parseAbsoluteInstant('from', fromRaw, requestId);
    const to = this.parseAbsoluteInstant('to', toRaw, requestId);
    if (from.getTime() >= to.getTime()) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'from must be strictly before to',
        400,
        { requestId, details: { from: fromRaw, to: toRaw } },
      );
    }
    const visibility = await req.resolveVisibility!();
    return this.reportingService.getGuaranteeExposure(
      {
        tenant_id: authContext.tenant_id,
        user_id: authContext.sub,
        scopes: authContext.scopes,
        visibility,
        ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
      },
      { from, to },
    );
  }

  // T9-B3 — assignment-pipeline current-snapshot operational view. Governed by
  // Aramo-T9-B3-Directive-v1_0-LOCKED. Counts-only current snapshot — NO query
  // parameters (no from/to, §4/§10). report:read + tenant/site/A3. No commercial
  // data, no row-level items.
  @Get('assignment-pipeline')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('report:read')
  @RequireSiteMatch()
  async assignmentPipeline(
    @AuthContext() authContext: AuthContextType,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @Req() req: Request,
  ): Promise<AssignmentPipelineReportView> {
    const visibility = await req.resolveVisibility!();
    return this.reportingService.getAssignmentPipeline({
      tenant_id: authContext.tenant_id,
      user_id: authContext.sub,
      scopes: authContext.scopes,
      visibility,
      ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
    });
  }

  // T9-B4 — margin current-snapshot operational view. Governed by
  // Aramo-T9-B4-Directive-v1_0-LOCKED. AGGREGATE-ONLY current snapshot — NO query
  // parameters (§5/§22). COMPOUND authorization: report:read AND
  // assignment:commercials:read (§12 D-9 — RolesGuard requires every listed scope,
  // so either alone → 403), plus tenant/site/A3. No row-level commercial data.
  @Get('margin')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('report:read', 'assignment:commercials:read')
  @RequireSiteMatch()
  async margin(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @Req() req: Request,
  ): Promise<MarginReportView> {
    const visibility = await req.resolveVisibility!();
    return this.reportingService.getMargin(
      {
        tenant_id: authContext.tenant_id,
        user_id: authContext.sub,
        scopes: authContext.scopes,
        visibility,
        ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
      },
      requestId,
    );
  }

  // T9-B2 — authoritative fallthrough-rate + reasons operational report.
  // Governed by Aramo-T9-B2-Directive-v1_0-LOCKED. Placement-attempt level,
  // post-acceptance/pre-start (FELL_THROUGH + NO_SHOW) over the cohort of
  // attempts whose first OFFER_ACCEPTED ∈ [from,to). `from`/`to` REQUIRED
  // absolute ISO instants (reuses parseAbsoluteInstant); report:read +
  // tenant/site/A3. Reasons are grouped by canonical reason_code/label only —
  // reason_detail (PII) is never read or exposed (§16).
  @Get('fallthrough')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('report:read')
  @RequireSiteMatch()
  async fallthrough(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Query('from') fromRaw: string | undefined,
    @Query('to') toRaw: string | undefined,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @Req() req: Request,
  ): Promise<FallthroughReportView> {
    const from = this.parseAbsoluteInstant('from', fromRaw, requestId);
    const to = this.parseAbsoluteInstant('to', toRaw, requestId);
    if (from.getTime() >= to.getTime()) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'from must be strictly before to',
        400,
        { requestId, details: { from: fromRaw, to: toRaw } },
      );
    }
    const visibility = await req.resolveVisibility!();
    return this.reportingService.getFallthrough(
      {
        tenant_id: authContext.tenant_id,
        user_id: authContext.sub,
        scopes: authContext.scopes,
        visibility,
        ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
      },
      { from, to },
    );
  }

  // L2-I (D4a / D5) — the RECRUITING funnel report (Pipeline-owned). Counts-only current
  // snapshot projected from the canonical L2-C PipelineStatus registry onto the six recruiting
  // stages — NO query parameters. report:read + tenant/site/A3 — the same guard chain as every
  // other reporting route. Carries NO hiring stage (its downstream counterpart is /hiring-funnel).
  @Get('recruiting-funnel')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('report:read')
  @RequireSiteMatch()
  async recruitingFunnel(
    @AuthContext() authContext: AuthContextType,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @Req() req: Request,
  ): Promise<RecruitingFunnelReportView> {
    const visibility = await req.resolveVisibility!();
    return this.reportingService.getRecruitingFunnel({
      tenant_id: authContext.tenant_id,
      user_id: authContext.sub,
      scopes: authContext.scopes,
      visibility,
      ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
    });
  }

  // L2-I (D4b / D5) — the HIRING funnel report (downstream-owner-attributed). Counts-only current
  // snapshot; every stage sourced from its OWNING aggregate (Submittal / Client-Selection / Offer /
  // Placement) via the reporting-owned ports + reads — NO query parameters. report:read +
  // tenant/site/A3. Carries NO recruiting stage (its upstream counterpart is /recruiting-funnel).
  @Get('hiring-funnel')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('report:read')
  @RequireSiteMatch()
  async hiringFunnel(
    @AuthContext() authContext: AuthContextType,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @Req() req: Request,
  ): Promise<HiringFunnelReportView> {
    const visibility = await req.resolveVisibility!();
    return this.reportingService.getHiringFunnel({
      tenant_id: authContext.tenant_id,
      user_id: authContext.sub,
      scopes: authContext.scopes,
      visibility,
      ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
    });
  }

  // L2-I (D3 / D5) — the SOURCE-EFFECTIVENESS / outcome-correlation report. Per L2-D source origin,
  // correlate the recruiting outcome (canonical status + disposition reasons) with the canonical
  // hiring outcome (PlacementProcess established) as CLASSIFIED EVIDENCE — NO ordinal quality
  // output (Rule C). Cohort = requisitions whose created_at ∈ [from, to). `from`/`to` are REQUIRED
  // absolute ISO instants carrying `Z`/offset (reuses parseAbsoluteInstant); date-only/zone-less
  // rejected 400 (VALIDATION_ERROR — an existing code). report:read + tenant/site/A3.
  @Get('source-effectiveness')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('report:read')
  @RequireSiteMatch()
  async sourceEffectiveness(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Query('from') fromRaw: string | undefined,
    @Query('to') toRaw: string | undefined,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @Req() req: Request,
  ): Promise<SourceEffectivenessReportView> {
    const from = this.parseAbsoluteInstant('from', fromRaw, requestId);
    const to = this.parseAbsoluteInstant('to', toRaw, requestId);
    if (from.getTime() >= to.getTime()) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'from must be strictly before to',
        400,
        { requestId, details: { from: fromRaw, to: toRaw } },
      );
    }
    const visibility = await req.resolveVisibility!();
    return this.reportingService.getSourceEffectiveness(
      {
        tenant_id: authContext.tenant_id,
        user_id: authContext.sub,
        scopes: authContext.scopes,
        visibility,
        ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
      },
      { from, to },
    );
  }

  // T9-B1 (§8 / D-5) — parse a REQUIRED reporting-period boundary. The value
  // must be an ISO 8601 date-TIME carrying an explicit zone (`Z` or ±hh:mm);
  // date-only ("2026-01-01") and zone-less ("2026-01-01T00:00:00") values are
  // rejected. Absolute instants ONLY — no date-only business-day semantics and
  // no tenant/user timezone inference. Returns the UTC-absolute Date.
  private parseAbsoluteInstant(
    field: 'from' | 'to',
    raw: string | undefined,
    requestId: string,
  ): Date {
    if (raw === undefined || raw.trim() === '') {
      throw new AramoError('VALIDATION_ERROR', `${field} is required`, 400, {
        requestId,
        details: { [field]: raw ?? null },
      });
    }
    const ISO_INSTANT =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
    const d = new Date(raw);
    if (!ISO_INSTANT.test(raw) || Number.isNaN(d.getTime())) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `invalid ${field}: expected an absolute ISO date-time with Z or explicit offset`,
        400,
        { requestId, details: { [field]: raw } },
      );
    }
    return d;
  }
}
