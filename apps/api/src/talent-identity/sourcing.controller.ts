import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import type { SubjectRef } from '@aramo/talent-trust';

import { SourcingService, type SourcingResult } from './sourcing.service.js';
import {
  AddToPipelineRequestDto,
  SaveToBenchRequestDto,
} from './dto/sourcing.dto.js';

// Promotion-Trigger slice-A — the sourcer's HTTP surface. Lives in apps/api
// (ABOVE the I15 wall): promotes a sourced L2 subject into an ATS TalentRecord
// (via PromotionService, behind the identity gate) and associates it to a
// requisition (Add to Pipeline) or the tenant bench (Save to Pool). Both
// endpoints require the talent:source scope (sourcer+). Tenant is taken from the
// auth context, NEVER the body (tenant-wall). A gate deferral returns the
// deferral status with no record minted (200 — an expected outcome, not an
// error; slice-B's surface renders it).
@Controller('v1/sourcing')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class SourcingController {
  constructor(private readonly sourcing: SourcingService) {}

  @Post('pipeline')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:source')
  async addToPipeline(
    @AuthContext() authContext: AuthContextType,
    @Body() dto: AddToPipelineRequestDto,
  ): Promise<SourcingResult> {
    const subjectRef: SubjectRef = {
      tenant_id: authContext.tenant_id,
      ref_type: dto.ref_type,
      ref_id: dto.ref_id,
    };
    return this.sourcing.promoteAndAddToPipeline(subjectRef, dto.requisition_id);
  }

  @Post('bench')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:source')
  async saveToBench(
    @AuthContext() authContext: AuthContextType,
    @Body() dto: SaveToBenchRequestDto,
  ): Promise<SourcingResult> {
    const subjectRef: SubjectRef = {
      tenant_id: authContext.tenant_id,
      ref_type: dto.ref_type,
      ref_id: dto.ref_id,
    };
    return this.sourcing.promoteAndSaveToBench(subjectRef);
  }
}
