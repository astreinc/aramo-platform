import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { AramoError, RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { COMPANY_CLIENT_CHECK_PORT, type CompanyClientCheckPort } from '@aramo/requisition';
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
    // CSP PR-5 — CLIENT-scope authoring is ownership-guarded through the SAME
    // established CompanyClientCheckPort seam used by pre-start + client-submittal,
    // closing the engagement parity gap (a CLIENT engagement policy could
    // previously be published against a company_id not owned by the tenant).
    @Inject(COMPANY_CLIENT_CHECK_PORT) private readonly clientCheck: CompanyClientCheckPort,
  ) {}

  /** Provider-neutral evidence-channel capabilities (voice + email available per COMM-C2B). */
  @Get('capabilities')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('engagement:policy:read')
  capabilities(): { items: ReturnType<EngagementPolicyService['capabilities']> } {
    return { items: this.policy.capabilities() };
  }

  /**
   * The effective (TENANT/CLIENT/REQUISITION-resolved) engagement policy, or null,
   * plus `governed` — whether the tenant has EVER published a policy. Together they
   * express the C3 three-state for the admin surface: governed=false → never
   * configured (dormant/non-enforcing); governed=true + effective=null →
   * configured-but-no-effective (fail-closed); effective present → evaluated.
   */
  @Get('policy/effective')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('engagement:policy:read')
  async effective(
    @Query('requisition_id') requisitionId: string | undefined,
    @Query('company_id') companyId: string | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ governed: boolean; effective: unknown }> {
    await this.assertClientOwned(auth.tenant_id, companyId, requestId);
    const [governed, effective] = await Promise.all([
      this.policy.isTenantGoverned(auth.tenant_id),
      // CSP PA-2c — the annotated read/admin view (per-channel source + provenance +
      // effective enforcement_mode). Provenance is backend truth, never FE-inferred.
      this.policy.resolveEffectiveView(auth.tenant_id, {
        company_id: companyId ?? null,
        requisition_id: requisitionId ?? null,
      }),
    ]);
    return { governed, effective };
  }

  /** The raw per-layer read (§8): each scope's own definition + merged effective. */
  @Get('policy/layers')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('engagement:policy:read')
  async layers(
    @Query('requisition_id') requisitionId: string | undefined,
    @Query('company_id') companyId: string | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ layers: unknown }> {
    await this.assertClientOwned(auth.tenant_id, companyId, requestId);
    const layers = await this.policy.readLayers(auth.tenant_id, {
      company_id: companyId ?? null,
      requisition_id: requisitionId ?? null,
    });
    return { layers };
  }

  /** The immutable version history for one engagement policy scope (§10), newest first. */
  @Get('policy/history')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('engagement:policy:read')
  async history(
    @Query('scope') scope: string | undefined,
    @Query('scope_ref') scopeRef: string | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ versions: unknown }> {
    const resolvedScope = this.assertScope(scope, requestId);
    if (resolvedScope === 'CLIENT') {
      await this.assertClientOwned(auth.tenant_id, scopeRef, requestId, true);
    } else if (resolvedScope === 'REQUISITION' && !scopeRef) {
      throw new AramoError('ENGAGEMENT_POLICY_SCHEMA_INVALID', 'REQUISITION scope requires scope_ref', 422, {
        requestId,
        details: { reason: 'SCOPE_REF_REQUIRED', scope: resolvedScope },
      });
    }
    const versions = await this.policy.history(auth.tenant_id, resolvedScope, scopeRef ?? null);
    return { versions };
  }

  private assertScope(scope: string | undefined, requestId: string): 'TENANT' | 'CLIENT' | 'REQUISITION' {
    if (scope !== 'TENANT' && scope !== 'CLIENT' && scope !== 'REQUISITION') {
      throw new AramoError('ENGAGEMENT_POLICY_SCHEMA_INVALID', 'scope must be TENANT | CLIENT | REQUISITION', 422, {
        requestId,
        details: { reason: 'INVALID_SCOPE', scope: scope ?? null },
      });
    }
    return scope;
  }

  // §27 — a client-level read carrying a company_id must target a company the caller
  // tenant owns as a CLIENT (the same CompanyClientCheckPort seam as publish).
  private async assertClientOwned(
    tenantId: string,
    companyId: string | undefined,
    requestId: string,
    required = false,
  ): Promise<void> {
    if (!companyId) {
      if (required) {
        throw new AramoError('ENGAGEMENT_POLICY_SCHEMA_INVALID', 'CLIENT scope requires scope_ref', 422, {
          requestId,
          details: { reason: 'SCOPE_REF_REQUIRED', scope: 'CLIENT' },
        });
      }
      return;
    }
    const owned = await this.clientCheck.isClientCompany({ tenant_id: tenantId, company_id: companyId });
    if (!owned) {
      throw new AramoError('ENGAGEMENT_POLICY_SCHEMA_INVALID', 'company_id is not a CLIENT company of this tenant', 422, {
        requestId,
        details: { reason: 'COMPANY_NOT_CLIENT', company_id: companyId },
      });
    }
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
    // CSP PR-5 — a CLIENT-scoped engagement policy MUST target a company the tenant
    // owns as a CLIENT. Verified through the CompanyClientCheckPort BEFORE any write,
    // mirroring pre-start + client-submittal. (TENANT/REQUISITION scopes are untouched.)
    if (dto.scope === 'CLIENT') {
      if (!dto.scope_ref) {
        throw new AramoError('ENGAGEMENT_POLICY_SCHEMA_INVALID', 'CLIENT scope requires scope_ref', 422, {
          requestId,
          details: { reason: 'SCOPE_REF_REQUIRED', scope: dto.scope },
        });
      }
      const owned = await this.clientCheck.isClientCompany({
        tenant_id: auth.tenant_id,
        company_id: dto.scope_ref,
      });
      if (!owned) {
        throw new AramoError(
          'ENGAGEMENT_POLICY_SCHEMA_INVALID',
          'scope_ref is not a CLIENT company of this tenant',
          422,
          { requestId, details: { reason: 'COMPANY_NOT_CLIENT', scope: dto.scope, scope_ref: dto.scope_ref } },
        );
      }
    }
    const definition = {
      schema_version: dto.schema_version,
      scope: dto.scope,
      scope_ref: dto.scope_ref ?? null,
      requirements: dto.requirements,
      ...(dto.enforcement_mode === undefined ? {} : { enforcement_mode: dto.enforcement_mode }),
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
