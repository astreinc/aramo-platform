import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import type { SubjectRef } from '@aramo/talent-trust';

import {
  SourcingService,
  type SourcingResult,
  type PoolPage,
  type SubjectDetail,
} from './sourcing.service.js';
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

  // ---- Slice B-api — the sourcing-pool read surface (talent:source) ----------

  // The pre-promotion pool: un-promoted sourced subjects (bands +
  // open_contradiction_count + display name/email), keyset-paginated oldest-first.
  @Get('pool')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:source')
  async pool(
    @AuthContext() authContext: AuthContextType,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PoolPage> {
    return this.sourcing.getPool(authContext.tenant_id, {
      cursor: cursor ?? null,
      ...(limit !== undefined && limit.length > 0 ? { limit: Number(limit) } : {}),
    });
  }

  // Subject drill-in: trust bands + evidence ledger + refs + pending identity
  // merge advisories (adjudicated via the existing advisory-resolution endpoints,
  // now reachable by a sourcer via the identity:resolve grant).
  @Get('pool/:subjectId')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:source')
  async subjectDetail(
    @AuthContext() authContext: AuthContextType,
    @Param('subjectId', ParseUUIDPipe) subjectId: string,
  ): Promise<SubjectDetail> {
    return this.sourcing.getSubjectDetail(authContext.tenant_id, subjectId);
  }

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
