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
import { AramoError, RequestId } from '@aramo/common';
import { AddTalentPolicyService, PipelineRepository } from '@aramo/pipeline';
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
  constructor(
    private readonly sourcing: SourcingService,
    // ADR-0024 PR-3b — the SAME policy service PipelineController uses (reused,
    // not duplicated), and PipelineRepository for the standalone DENY-provenance
    // write.
    private readonly addTalentPolicy: AddTalentPolicyService,
    private readonly pipelineRepository: PipelineRepository,
  ) {}

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
    @RequestId() requestId: string,
  ): Promise<SourcingResult> {
    // ADR-0024 §D10 / PR-3b — the SECOND command boundary for
    // REQUISITION_TALENT · ADD (same resource/action as PipelineController; the
    // caller lives in request_metadata, NOT a distinct action — D6). The policy
    // call runs at the controller, after guards, and BEFORE the service is
    // invoked — hence BEFORE promotion, so a DENY never leaves a promoted
    // subject with no pipeline row (ruling 4). The `talent:source` scope maps
    // through the same agnostic adapter.
    const outcome = await this.addTalentPolicy.decide({
      tenant_id: authContext.tenant_id,
      requisition_id: dto.requisition_id,
      scopes: authContext.scopes,
      actor_id: authContext.sub,
      origin: 'ui',
      correlation_id: requestId,
    });

    if (!outcome.allowed) {
      // No promotion, no add. Record provenance standalone; refuse with the
      // reason_code ONLY.
      await this.pipelineRepository.recordDecision(outcome.provenance);
      throw new AramoError(
        'POLICY_DENIED',
        'The requisition lifecycle policy denied this command',
        403,
        { requestId, details: { reason_code: outcome.reason_code } },
      );
    }

    const subjectRef: SubjectRef = {
      tenant_id: authContext.tenant_id,
      ref_type: dto.ref_type,
      ref_id: dto.ref_id,
    };
    // ALLOW: thread the provenance so it commits INSIDE the pipeline write's tx.
    const result = await this.sourcing.promoteAndAddToPipeline(subjectRef, dto.requisition_id, {
      provenance: outcome.provenance,
    });
    // Track-wide invariant: a mutation never commits without its provenance
    // (create() commits it in-tx); provenance MAY exist without a mutation.
    // When the promotion DEFERS (or an idempotent no-op fires), no pipeline row
    // was written, so no in-tx provenance landed — record the ALLOW decision
    // standalone. The deferral is a promotion-layer outcome, not a policy one:
    // the recorded decision stays the engine's ALLOW.
    if (result.pipeline_id == null) {
      await this.pipelineRepository.recordDecision(outcome.provenance);
    }
    return result;
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
