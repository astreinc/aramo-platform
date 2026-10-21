import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { IdentityAuditService } from '../audit/identity-audit.service.js';

import {
  DomainVerificationDelegationService,
  type DelegationView,
} from './domain-verification-delegation.service.js';
import { DomainVerificationService } from './domain-verification.service.js';
import type { DomainVerificationView } from './domain-verification.view.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
// Domain-Enforcement P3 (LOCKED) §4/§5 — VERIFIED now promotes the domain claim
// to AUTHORITATIVE (the response's additive domain_claim / domain_claim_conflict
// fields report it); re-issue while VERIFIED is refused (409 already_verified);
// and the owner / admin can delegate the verification to an IT administrator
// (GET/POST /delegations, DELETE /delegations/:id — same scope, same tenant pin).
// P1's invite domain-lock is unaffected.
@Controller('v1/tenant/domain-verification')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class DomainVerificationController {
  constructor(
    private readonly domain: DomainVerificationService,
    private readonly audit: IdentityAuditService,
    private readonly delegations: DomainVerificationDelegationService,
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
    const { view, verified, domain, claim_outcome } = await this.domain.checkVerification(
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
        payload: { domain, ...(claim_outcome === null ? {} : { claim_outcome }) },
      });
    }
    return view;
  }

  // ── P3 §5 — delegation to an IT / domain administrator ──

  @Get('delegations')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('tenant:admin:domain')
  async listDelegations(
    @AuthContext() authContext: AuthContextType,
  ): Promise<{ items: DelegationView[] }> {
    return this.delegations.listActive(authContext.tenant_id);
  }

  @Post('delegations')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('tenant:admin:domain')
  async issueDelegation(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Body() body: unknown,
  ): Promise<DelegationView> {
    const delegate_email =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['delegate_email']
        : undefined;
    return this.delegations.issue({
      tenant_id: authContext.tenant_id,
      actor_user_id: authContext.sub,
      delegate_email,
      request_id: requestId,
    });
  }

  @Delete('delegations/:id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('tenant:admin:domain')
  async revokeDelegation(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('id') id: string,
  ): Promise<DelegationView> {
    if (!UUID_RE.test(id)) {
      throw new AramoError('NOT_FOUND', 'Delegation not found', 404, { requestId });
    }
    return this.delegations.revoke({
      tenant_id: authContext.tenant_id,
      actor_user_id: authContext.sub,
      id,
      request_id: requestId,
    });
  }
}
