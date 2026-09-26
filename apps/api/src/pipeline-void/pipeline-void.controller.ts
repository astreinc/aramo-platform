import { Body, Controller, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RequireSiteMatch, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { isVoidReason, type PipelineView } from '@aramo/pipeline';

import { PipelineVoidService } from './pipeline-void.service.js';

// Accidental-Add Correction — the governed VOID surface (apps/api composition root).
// `POST /v1/pipelines/:id/void` — a DEDICATED route (not the bare recruiter /actions or
// /transition surfaces, which cannot compose the engagement + downstream guards across the
// ADR-0029 wall; the DTO adaptation §9 permits). Guard chain is the A2 pattern: tenant →
// scope (pipeline:change-status, reused per §17) → site; capability `ats`. CAS on
// expected_version. Backend remains authoritative — the caller cannot bypass the guards.
@Controller('v1/pipelines')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class PipelineVoidController {
  constructor(private readonly voidService: PipelineVoidService) {}

  @Post(':id/void')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pipeline:change-status')
  @RequireSiteMatch()
  async voidEpisode(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: { reason?: unknown; expected_version?: unknown },
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<PipelineView> {
    if (typeof body.expected_version !== 'number') {
      throw new AramoError('VALIDATION_ERROR', 'expected_version is required for VOID', 422, {
        requestId,
        details: { field: 'expected_version' },
      });
    }
    if (!isVoidReason(body.reason)) {
      throw new AramoError('VALIDATION_ERROR', 'reason must be ADDED_BY_MISTAKE', 422, {
        requestId,
        details: { field: 'reason' },
      });
    }
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    return this.voidService.voidEpisode({
      tenant_id: authContext.tenant_id,
      pipeline_id: id,
      reason: body.reason,
      expected_version: body.expected_version,
      changed_by_id: authContext.sub,
      visible_requisition_ids: visibleReqIds,
      requestId,
    });
  }
}
