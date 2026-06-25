import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { IdentityAuditService } from '../audit/identity-audit.service.js';

import { DomainVerificationService } from './domain-verification.service.js';
import type { DomainVerificationView } from './domain-verification.view.js';

// Domain-Enforcement P2b §6 — the tenant-admin domain-verification surface.
//
// Guard chain (the tenant-admin pattern, verbatim — matches
// TenantProfileController / SitesController / TenantUserManagementController):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('core')                  — class-level (tenant axis)
//   @RequireScopes('tenant:admin:domain')       — route-level. DEDICATED scope
//     (seeded to tenant_owner + tenant_admin), distinct from settings/profile/
//     sites so the admin taxonomy stays coherent.
//
// IMPLICIT-TENANT PATTERN: tenant_id derives ONLY from authContext.tenant_id —
// no URL/body tenant override. A tenant_admin in tenant A can never read or
// mutate tenant B's verification state.
//
// AUDIT (the app-layer two-call seam): the controller injects both the service
// AND IdentityAuditService; it emits identity.domain.verification.requested when
// a token is (re)issued, and identity.domain.verified ONLY on the transition to
// VERIFIED (no-op-no-audit — a re-check that stays PENDING, or an already-VERIFIED
// no-op, emits nothing).
//
// INFORMATIONAL (PO ruling (a)): VERIFIED gates nothing — these endpoints only
// read/advance the status; P1's invite domain-lock is unaffected.
@Controller('v1/tenant/domain-verification')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class DomainVerificationController {
  constructor(
    private readonly domain: DomainVerificationService,
    private readonly audit: IdentityAuditService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('tenant:admin:domain')
  async getStatus(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<DomainVerificationView> {
    return this.domain.getStatus(authContext.tenant_id, requestId);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('tenant:admin:domain')
  async requestVerification(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<DomainVerificationView> {
    const { view, domain } = await this.domain.requestVerification(
      authContext.tenant_id,
      requestId,
    );
    await this.audit.writeEvent({
      event_type: 'identity.domain.verification.requested',
      actor_type: 'user',
      actor_id: authContext.sub,
      tenant_id: authContext.tenant_id,
      subject_id: authContext.tenant_id,
      payload: { domain },
    });
    return view;
  }

  @Post('check')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('tenant:admin:domain')
  async checkVerification(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<DomainVerificationView> {
    const { view, verified, domain } = await this.domain.checkVerification(
      authContext.tenant_id,
      requestId,
    );
    if (verified) {
      await this.audit.writeEvent({
        event_type: 'identity.domain.verified',
        actor_type: 'user',
        actor_id: authContext.sub,
        tenant_id: authContext.tenant_id,
        subject_id: authContext.tenant_id,
        payload: { domain },
      });
    }
    return view;
  }
}
