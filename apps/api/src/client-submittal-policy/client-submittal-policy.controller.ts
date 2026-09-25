import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { AramoError, RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { COMPANY_CLIENT_CHECK_PORT, type CompanyClientCheckPort } from '@aramo/requisition';
import {
  ClientSubmittalPolicyService,
  DEFAULT_OVERRIDE_POLICY,
  type ClientSubmittalPolicyScope,
} from '@aramo/client-submittal-policy';

import { PublishClientSubmittalPolicyDto } from './dto/client-submittal-policy.dto.js';

// CSP PR-2 — the Client Submittal Policy admin HTTP surface (DARK: authoring +
// effective read only; NO submit-command reference — that wiring is PR-3). CLIENT-
// scope authoring is ownership-guarded through the established CompanyClientCheckPort
// seam (no @aramo/company import).
@Controller('v1/client-submittal-policy')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ClientSubmittalPolicyController {
  constructor(
    private readonly policy: ClientSubmittalPolicyService,
    @Inject(COMPANY_CLIENT_CHECK_PORT) private readonly clientCheck: CompanyClientCheckPort,
  ) {}

  /**
   * The effective (TENANT/CLIENT/REQUISITION-resolved) policy with per-requirement
   * source layer + provenance (§7/§9), or null. This is the authoritative effective
   * read the admin UI consumes — provenance is backend truth, never FE-inferred.
   */
  @Get('effective')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('client-submittal-policy:read')
  async effective(
    @Query('company_id') companyId: string | undefined,
    @Query('requisition_id') requisitionId: string | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ effective: unknown }> {
    await this.assertClientOwned(auth.tenant_id, companyId, requestId);
    const effective = await this.policy.resolveEffectiveView(auth.tenant_id, {
      company_id: companyId ?? null,
      requisition_id: requisitionId ?? null,
    });
    return { effective };
  }

  /**
   * The raw per-layer read (§8): each scope's OWN definition (TENANT / CLIENT /
   * REQUISITION) plus the merged effective. Powers the editor's inherit/override
   * toggles and the "Tenant: X -> Client: Y" delta.
   */
  @Get('layers')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('client-submittal-policy:read')
  async layers(
    @Query('company_id') companyId: string | undefined,
    @Query('requisition_id') requisitionId: string | undefined,
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

  /**
   * The immutable version history for one policy scope (§10), newest first. A CLIENT
   * scope's scope_ref must be an owned client company.
   */
  @Get('history')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('client-submittal-policy:read')
  async history(
    @Query('scope') scope: string | undefined,
    @Query('scope_ref') scopeRef: string | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ versions: unknown }> {
    const resolvedScope = this.assertScope(scope, requestId);
    if (resolvedScope === 'CLIENT') {
      await this.assertClientOwned(auth.tenant_id, scopeRef, requestId, true);
    }
    if ((resolvedScope === 'CLIENT' || resolvedScope === 'REQUISITION') && !scopeRef) {
      throw new AramoError('CLIENT_SUBMITTAL_POLICY_INVALID', `${resolvedScope} scope requires scope_ref`, 422, {
        requestId,
        details: { reason: 'SCOPE_REF_REQUIRED', scope: resolvedScope },
      });
    }
    const versions = await this.policy.history(auth.tenant_id, resolvedScope, scopeRef ?? null);
    return { versions };
  }

  private assertScope(scope: string | undefined, requestId: string): ClientSubmittalPolicyScope {
    if (scope !== 'TENANT' && scope !== 'CLIENT' && scope !== 'REQUISITION') {
      throw new AramoError('CLIENT_SUBMITTAL_POLICY_INVALID', 'scope must be TENANT | CLIENT | REQUISITION', 422, {
        requestId,
        details: { reason: 'INVALID_SCOPE', scope: scope ?? null },
      });
    }
    return scope;
  }

  /**
   * §27 — a client-level read carrying a company_id must target a company the caller
   * tenant owns as a CLIENT (the same CompanyClientCheckPort seam as publish). `required`
   * forces the check even for a history scope_ref.
   */
  private async assertClientOwned(
    tenantId: string,
    companyId: string | undefined,
    requestId: string,
    required = false,
  ): Promise<void> {
    if (!companyId) {
      if (required) {
        throw new AramoError('CLIENT_SUBMITTAL_POLICY_INVALID', 'CLIENT scope requires scope_ref', 422, {
          requestId,
          details: { reason: 'SCOPE_REF_REQUIRED', scope: 'CLIENT' },
        });
      }
      return;
    }
    const owned = await this.clientCheck.isClientCompany({ tenant_id: tenantId, company_id: companyId });
    if (!owned) {
      throw new AramoError('CLIENT_SUBMITTAL_POLICY_INVALID', 'company_id is not a CLIENT company of this tenant', 422, {
        requestId,
        details: { reason: 'COMPANY_NOT_CLIENT', company_id: companyId },
      });
    }
  }

  /** Publish a new immutable version at TENANT / CLIENT / REQUISITION scope. */
  @Post()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('client-submittal-policy:write')
  async publish(
    @Body() dto: PublishClientSubmittalPolicyDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ published: unknown }> {
    const scope = dto.scope as ClientSubmittalPolicyScope;
    let scope_ref: string | null = null;
    if (scope === 'CLIENT') {
      if (!dto.scope_ref) {
        throw new AramoError('CLIENT_SUBMITTAL_POLICY_INVALID', 'CLIENT scope requires scope_ref', 422, {
          requestId,
          details: { reason: 'SCOPE_REF_REQUIRED', scope },
        });
      }
      const owned = await this.clientCheck.isClientCompany({ tenant_id: auth.tenant_id, company_id: dto.scope_ref });
      if (!owned) {
        throw new AramoError('CLIENT_SUBMITTAL_POLICY_INVALID', 'scope_ref is not a CLIENT company of this tenant', 422, {
          requestId,
          details: { reason: 'COMPANY_NOT_CLIENT', scope, scope_ref: dto.scope_ref },
        });
      }
      scope_ref = dto.scope_ref;
    } else if (scope === 'REQUISITION') {
      if (!dto.scope_ref) {
        throw new AramoError('CLIENT_SUBMITTAL_POLICY_INVALID', 'REQUISITION scope requires scope_ref', 422, {
          requestId,
          details: { reason: 'SCOPE_REF_REQUIRED', scope },
        });
      }
      scope_ref = dto.scope_ref;
    }
    const definition = {
      requirements: dto.requirements.map((r) => ({
        key: r.key,
        disposition: r.disposition,
        override_class: r.override_class,
        override_policy: r.override_policy ?? DEFAULT_OVERRIDE_POLICY,
      })),
    };
    const published = await this.policy.publish({
      tenant_id: auth.tenant_id,
      scope,
      scope_ref,
      version: dto.version,
      definition,
      published_by: auth.sub,
      ...(dto.effective_from === undefined ? {} : { effective_from: new Date(dto.effective_from) }),
    });
    return { published };
  }
}
