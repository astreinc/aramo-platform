import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { AramoError, RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import {
  GuaranteeTermRepository,
  parseTermCalendarDate,
  type GuaranteeTermVersionView,
} from '@aramo/placement';

import { CreateGuaranteeTermsDto, ReviseGuaranteeTermsDto } from './dto/guarantee-terms.dto.js';

// Track 7 / T7-P3 — the reusable, requisition-keyed, placement-owned guarantee-term-versioning
// HTTP surface (directive §8). Deliberately a SEPARATE resource from /v1/placements/:id: the
// aggregate is keyed by (tenant, requisition_id) so terms are configurable BEFORE any
// PlacementProcess is started, and there is NO placement->requisition library dependency
// (requisition_id is a plain path UUID, never a cross-schema read). Tenant-isolated; tenant_id +
// recorded_by come from the JWT, never the body. Writes require the DEDICATED
// placement:permanent:terms:write authority; reads reuse placement:permanent:read (least
// privilege, §3.7). No @RequireSiteMatch — terms are requisition-level configuration, not a
// site-scoped placement row.
@Controller('v1/permanent-placement-guarantee-terms')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class GuaranteeTermsController {
  constructor(private readonly terms: GuaranteeTermRepository) {}

  // Create the initial (open) guarantee-term version for a requisition. Overlap with an
  // existing version is a 409 (TERMS_OVERLAP) — use /revise to supersede.
  @Post('requisitions/:requisitionId')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('placement:permanent:terms:write')
  async create(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('requisitionId', ParseUUIDPipe) requisitionId: string,
    @Body() body: CreateGuaranteeTermsDto,
  ): Promise<GuaranteeTermVersionView> {
    return this.terms.create(
      {
        tenant_id: auth.tenant_id,
        requisition_id: requisitionId,
        effective_from: body.effective_from,
        guarantee_duration_days: body.guarantee_duration_days,
        remedy_policy: body.remedy_policy as GuaranteeTermVersionView['remedy_policy'],
        guarantee_exposure_amount: body.guarantee_exposure_amount,
        currency: body.currency,
        source_type: body.source_type,
        source_reference: body.source_reference ?? null,
        source_version: body.source_version ?? null,
        correlation_id: body.correlation_id ?? null,
        recorded_by: auth.sub,
      },
      requestId,
    );
  }

  // The full version history for a requisition, newest effective_from first.
  @Get('requisitions/:requisitionId')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('placement:permanent:read')
  async list(
    @AuthContext() auth: AuthContextType,
    @Param('requisitionId', ParseUUIDPipe) requisitionId: string,
  ): Promise<{ items: GuaranteeTermVersionView[] }> {
    const items = await this.terms.listVersions(auth.tenant_id, requisitionId);
    return { items };
  }

  // The version effective at an explicit as_of calendar date (deterministic, §8). Defaults to
  // the current UTC date when as_of is omitted. A malformed as_of is a fail-closed 422.
  @Get('requisitions/:requisitionId/effective')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('placement:permanent:read')
  async effective(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('requisitionId', ParseUUIDPipe) requisitionId: string,
    @Query('as_of') asOf?: string,
  ): Promise<GuaranteeTermVersionView> {
    const asOfDate = this.resolveAsOf(asOf, requestId);
    return this.terms.getEffective(auth.tenant_id, requisitionId, asOfDate, requestId);
  }

  // Revise the current version: first-close the predecessor at effective_from and insert the
  // successor atomically. No backdating.
  @Post('requisitions/:requisitionId/revise')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('placement:permanent:terms:write')
  async revise(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('requisitionId', ParseUUIDPipe) requisitionId: string,
    @Body() body: ReviseGuaranteeTermsDto,
  ): Promise<GuaranteeTermVersionView> {
    return this.terms.revise(
      {
        tenant_id: auth.tenant_id,
        requisition_id: requisitionId,
        effective_from: body.effective_from,
        guarantee_duration_days: body.guarantee_duration_days,
        remedy_policy: body.remedy_policy as GuaranteeTermVersionView['remedy_policy'],
        guarantee_exposure_amount: body.guarantee_exposure_amount,
        currency: body.currency,
        source_type: body.source_type,
        source_reference: body.source_reference ?? null,
        source_version: body.source_version ?? null,
        correlation_id: body.correlation_id ?? null,
        recorded_by: auth.sub,
      },
      requestId,
    );
  }

  private resolveAsOf(asOf: string | undefined, requestId: string): Date {
    if (asOf == null || asOf.length === 0) {
      const now = new Date();
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    }
    const parsed = parseTermCalendarDate(asOf);
    if (parsed === null) {
      throw new AramoError('PERMANENT_PLACEMENT_TERMS_WINDOW_INVALID', 'as_of must be a calendar date (yyyy-mm-dd)', 422, {
        requestId,
        details: { reason: 'as_of_invalid', as_of: asOf },
      });
    }
    return parsed;
  }
}
