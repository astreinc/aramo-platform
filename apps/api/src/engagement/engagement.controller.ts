import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { AramoError, RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import {
  EngagementPolicyService,
  EngagementPolicyValidationError,
  type EngagementPolicyDefinition,
} from '@aramo/engagement';

import { EngagementGateService } from './engagement-gate.service.js';
import { PublishEngagementPolicyRequestDto } from './dto/engagement.dto.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// COMM-C3 — Tenant Engagement Policy admin + recruiter readiness surface. Admin
// read/publish ride the dedicated engagement:policy:* scopes (R16, tenant_admin/
// owner via seed — no role-name check here). The recruiter readiness read rides
// pipeline:read (the requisition-drawer read authority). Three-axis authorization
// mirrors the other ATS controllers. All reads are provider-neutral (R14).
@Controller('v1/engagement')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class EngagementController {
  constructor(
    private readonly policy: EngagementPolicyService,
    private readonly gate: EngagementGateService,
  ) {}

  /** Provider-neutral evidence-channel capabilities (voice available / email not). */
  @Get('capabilities')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('engagement:policy:read')
  capabilities(): { items: ReturnType<EngagementPolicyService['capabilities']> } {
    return { items: this.policy.capabilities() };
  }

  /** The effective (TENANT/CLIENT/REQUISITION-resolved) engagement policy, or null. */
  @Get('policy/effective')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('engagement:policy:read')
  async effective(
    @Query('requisition_id') requisitionId: string | undefined,
    @Query('company_id') companyId: string | undefined,
    @AuthContext() auth: AuthContextType,
  ): Promise<{ effective: unknown }> {
    const effective = await this.policy.resolveEffective(auth.tenant_id, {
      company_id: companyId ?? null,
      requisition_id: requisitionId ?? null,
    });
    return { effective };
  }

  /** Publish a new immutable engagement-policy version (validated + activation-guarded). */
  @Post('policy')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('engagement:policy:write')
  async publish(
    @Body() dto: PublishEngagementPolicyRequestDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ published: unknown }> {
    const definition = {
      schema_version: dto.schema_version,
      scope: dto.scope,
      scope_ref: dto.scope_ref ?? null,
      requirements: dto.requirements,
    } as unknown as EngagementPolicyDefinition;
    try {
      const published = await this.policy.publish({
        tenant_id: auth.tenant_id,
        version: dto.version,
        definition,
        published_by: auth.sub,
        ...(dto.effective_from === undefined ? {} : { effective_from: new Date(dto.effective_from) }),
      });
      return { published };
    } catch (err) {
      if (err instanceof EngagementPolicyValidationError) {
        // ENGAGEMENT_POLICY_SCHEMA_INVALID | ENGAGEMENT_POLICY_NOT_ACTIVATABLE → 422.
        throw new AramoError(err.code as never, err.message, 422, {
          requestId,
          details: err.details ?? {},
        });
      }
      throw err;
    }
  }

  /** Recruiter readiness for a Talent × Requisition (drawer, R19). No mutation. */
  @Get('readiness')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('pipeline:read')
  async readiness(
    @Query('talent_id') talentId: string,
    @Query('requisition_id') requisitionId: string,
    @Query('company_id') companyId: string | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<unknown> {
    if (!UUID_RE.test(talentId ?? '') || !UUID_RE.test(requisitionId ?? '')) {
      throw new AramoError('VALIDATION_ERROR', 'talent_id and requisition_id must be UUIDs', 400, {
        requestId,
        details: {},
      });
    }
    return this.gate.readReadiness({
      tenant_id: auth.tenant_id,
      talent_id: talentId,
      requisition_id: requisitionId,
      company_id: companyId ?? null,
    });
  }
}
