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

  /** The effective (TENANT/CLIENT/REQUISITION-resolved) policy, or null. */
  @Get('effective')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('client-submittal-policy:read')
  async effective(
    @Query('company_id') companyId: string | undefined,
    @Query('requisition_id') requisitionId: string | undefined,
    @AuthContext() auth: AuthContextType,
  ): Promise<{ effective: unknown }> {
    const effective = await this.policy.resolveEffective(auth.tenant_id, {
      company_id: companyId ?? null,
      requisition_id: requisitionId ?? null,
    });
    return { effective };
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
