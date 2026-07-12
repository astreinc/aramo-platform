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
import { AramoError, RequestId } from '@aramo/common';
import {
  AuthContext,
  JwtAuthGuard,
  type AuthContextType,
} from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import {
  IdentityAuditRepository,
  TenantService,
  type AuditEventRow,
  type PlatformDashboardData,
} from '@aramo/identity';

import {
  InvitePlatformAdminRequestDto,
  InviteUserRequestDto,
  type InviteUserResponseDto,
} from './dto/invite-user.request.dto.js';
import { ProvisionTenantRequestDto } from './dto/provision-tenant.request.dto.js';
import type { ProvisionTenantResponseDto } from './dto/provision-tenant.response.dto.js';
import type { PlatformTenantListResponseDto } from './dto/tenant-list.response.dto.js';
import type { PlatformTenantAuditEventDto } from './dto/tenant-audit.response.dto.js';
import {
  CloseTenantRequestDto,
  ReactivateTenantRequestDto,
  StartOffboardingRequestDto,
  SuspendTenantRequestDto,
  type TenantLifecycleActionResponseDto,
} from './dto/tenant-lifecycle.request.dto.js';
import { PlatformInvitationService } from './platform-invitation.service.js';

// PlatformController — the apps/platform-admin HTTP surface (Lead ruling
// 6 + 10). Mirrors the auth-service / api / submittal posture:
//   - Class-level @UseGuards(JwtAuthGuard, RolesGuard).
//   - Per-route @RequireScopes('platform:...') metadata.
//   - Per-route consumer_type === 'platform' assertion (the DDR §13.1
//     tripwire's app-side enforcement; the namespace partition + the
//     scope catalog enforce the OTHER direction at the tenant routes).
//
// All routes are platform-tier:
//   POST /platform/tenants                                provision + invite Owner
//   GET  /platform/tenants                                list (super_admin view)
//   POST /platform/tenants/:tenant_id/invitations         invite a user into a tenant
//   POST /platform/admins/invitations                     invite another platform admin
@Controller('platform')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformController {
  constructor(
    private readonly invitations: PlatformInvitationService,
    private readonly tenantSvc: TenantService,
    private readonly auditRepo: IdentityAuditRepository,
  ) {}

  @Post('tenants')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('platform:tenant:provision')
  async provisionTenant(
    @Body() body: ProvisionTenantRequestDto,
    @AuthContext() authCtx: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ProvisionTenantResponseDto> {
    this.assertConsumerIsPlatform(authCtx, requestId);
    // Inc-3 PR-3.4 (B1) — default true byte-preserves the pre-3.4 provision
    // path for every existing caller that omits the field.
    const invite_owner = body.invite_owner ?? true;
    const result = await this.invitations.provisionTenantAndInviteOwner({
      name: body.name,
      owner_email: body.owner_email,
      owner_display_name: body.owner_display_name ?? null,
      capabilities: body.capabilities,
      actor_user_id: authCtx.sub,
      request_id: requestId,
      invite_owner,
    });
    return {
      tenant_id: result.tenant_id,
      tenant_name: result.tenant_name,
      owner_user_id: result.owner_user_id,
      owner_email: result.owner_email,
      membership_id: result.membership_id,
      capabilities: result.capabilities,
      invitation_sent: result.invitation_sent,
    };
  }

  // Platform-Console Increment-2 PR-1.5 (A1) — the platform-operator estate list.
  // Re-pointed from the session-mint read (getTenantsByUser, membership-gated) to
  // the ungated operator read: EVERY tenant, EVERY status (a suspended tenant is
  // MORE visible to an operator, not less). Optional `?status=` (exact) and `?q=`
  // (case-insensitive contains on name|slug) filters. Scope unchanged
  // (platform:tenant:read). The sentinel platform tenant appears like any row.
  @Get('tenants')
  @RequireScopes('platform:tenant:read')
  async listTenants(
    @AuthContext() authCtx: AuthContextType,
    @RequestId() requestId: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
  ): Promise<PlatformTenantListResponseDto> {
    this.assertConsumerIsPlatform(authCtx, requestId);
    const tenants = await this.tenantSvc.listTenantsForPlatform({ status, q });
    return { tenants };
  }

  // Inc-3 PR-3.8 (A) — the operator dashboard summary (the platform console's
  // default screen). One read-only aggregation over existing tenant + audit
  // rows: status_counts (sentinel-excluded, zero-filled), the onboarding funnel
  // (PROVISIONED oldest-first + invited-state), and recent tenant.* activity
  // across the estate. Same platform:tenant:read scope as the estate list — no
  // new scope; no new event types/columns/migration. R10: counts, ages, statuses
  // and events only — never a numeric rating of a tenant.
  @Get('dashboard')
  @RequireScopes('platform:tenant:read')
  async getDashboard(
    @AuthContext() authCtx: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<PlatformDashboardData> {
    this.assertConsumerIsPlatform(authCtx, requestId);
    return this.tenantSvc.getPlatformDashboard();
  }

  @Post('tenants/:tenant_id/invitations')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('platform:tenant:provision')
  async inviteUser(
    @Param('tenant_id', new ParseUUIDPipe()) tenant_id: string,
    @Body() body: InviteUserRequestDto,
    @AuthContext() authCtx: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<InviteUserResponseDto> {
    this.assertConsumerIsPlatform(authCtx, requestId);
    const result = await this.invitations.inviteUserIntoTenant({
      tenant_id,
      email: body.email,
      role_keys: body.role_keys,
      display_name: body.display_name ?? null,
      actor_user_id: authCtx.sub,
      pool: 'tenant',
      request_id: requestId,
    });
    return result;
  }

  // Platform-Console Increment-2 PR-1.5 (A2) — re-send the tenant owner's
  // invitation (platform:tenant:provision, per PR-1 §3-F). Guard: tenant must be
  // PROVISIONED (422 VALIDATION_ERROR reason `tenant_not_provisioned` otherwise;
  // 404 for an unknown tenant). Reuses the Pattern-A Cognito machinery
  // (MessageAction=RESEND) — nothing is recreated; emits tenant.owner_invite.sent
  // (reason `resend`). See PlatformInvitationService.resendOwnerInvite for the
  // reuse-vs-reissue reasoning and the PROVISIONED↔RESEND-eligibility alignment.
  @Post('tenants/:tenant_id/resend-owner-invite')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:tenant:provision')
  async resendOwnerInvite(
    @Param('tenant_id', new ParseUUIDPipe()) tenant_id: string,
    @AuthContext() authCtx: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{
    tenant_id: string;
    owner_user_id: string;
    owner_email: string;
    resent: true;
  }> {
    this.assertConsumerIsPlatform(authCtx, requestId);
    return this.invitations.resendOwnerInvite({
      tenant_id,
      actor_user_id: authCtx.sub,
      request_id: requestId,
    });
  }

  // Platform-Console Increment-2 PR-1 — tenant lifecycle read + operator actions.
  // Detail read (platform:tenant:read); the four transitions each require the
  // SEPARATE platform:tenant:lifecycle:manage scope (provision power ≠ lifecycle
  // power). Reason codes/text + offboarding retention args are enforced by the
  // DTO (400-shape) AND re-enforced authoritatively in TenantService. Illegal
  // transitions hard-fail (422) and emit tenant.lifecycle_transition_rejected.

  @Get('tenants/:tenant_id')
  @RequireScopes('platform:tenant:read')
  async getTenant(
    @Param('tenant_id', new ParseUUIDPipe()) tenant_id: string,
    @AuthContext() authCtx: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ tenant: import('@aramo/identity').TenantDto }> {
    this.assertConsumerIsPlatform(authCtx, requestId);
    const tenant = await this.tenantSvc.getTenantById(tenant_id);
    if (tenant === null) {
      throw new AramoError('NOT_FOUND', 'Tenant not found', 404, {
        requestId,
        details: { tenant_id },
      });
    }
    return { tenant };
  }

  // Platform-Console Increment-2 PR-2 (G1) — the tenant lifecycle audit timeline
  // for the operator detail screen. Read-only (platform:tenant:read), :tenant_id
  // from the URL (operator reads ANY tenant — the deliberate inverse of the
  // tenant-self audit surface which pins tenant_id from the JWT). Returns the
  // tenant's tenant.* events newest-first in a { events: [...] } envelope; the
  // raw event_payload is included (before→after/reason lives there) for the FE
  // timeline. 404 for an unknown tenant (mirrors getTenant).
  @Get('tenants/:tenant_id/audit')
  @RequireScopes('platform:tenant:read')
  async getTenantAudit(
    @Param('tenant_id', new ParseUUIDPipe()) tenant_id: string,
    @AuthContext() authCtx: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ events: PlatformTenantAuditEventDto[] }> {
    this.assertConsumerIsPlatform(authCtx, requestId);
    const tenant = await this.tenantSvc.getTenantById(tenant_id);
    if (tenant === null) {
      throw new AramoError('NOT_FOUND', 'Tenant not found', 404, {
        requestId,
        details: { tenant_id },
      });
    }
    const rows = await this.auditRepo.findTenantLifecycleAudit(tenant_id);
    return { events: rows.map(toPlatformAuditEvent) };
  }

  @Post('tenants/:tenant_id/suspend')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:tenant:lifecycle:manage')
  async suspendTenant(
    @Param('tenant_id', new ParseUUIDPipe()) tenant_id: string,
    @Body() body: SuspendTenantRequestDto,
    @AuthContext() authCtx: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<TenantLifecycleActionResponseDto> {
    this.assertConsumerIsPlatform(authCtx, requestId);
    const r = await this.tenantSvc.transitionTenantStatus({
      tenant_id,
      to: 'SUSPENDED',
      actor_id: authCtx.sub,
      actor_type: 'user',
      source: 'platform_console',
      reason_code: body.reasonCode,
      reason_text: body.reasonText,
      request_id: requestId,
    });
    return { tenant_id, from: r.from, to: r.to, status: r.to, changed: r.changed };
  }

  @Post('tenants/:tenant_id/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:tenant:lifecycle:manage')
  async reactivateTenant(
    @Param('tenant_id', new ParseUUIDPipe()) tenant_id: string,
    @Body() body: ReactivateTenantRequestDto,
    @AuthContext() authCtx: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<TenantLifecycleActionResponseDto> {
    this.assertConsumerIsPlatform(authCtx, requestId);
    const r = await this.tenantSvc.transitionTenantStatus({
      tenant_id,
      to: 'ACTIVE',
      actor_id: authCtx.sub,
      actor_type: 'user',
      source: 'platform_console',
      reason_code: body.reasonCode,
      request_id: requestId,
    });
    return { tenant_id, from: r.from, to: r.to, status: r.to, changed: r.changed };
  }

  @Post('tenants/:tenant_id/start-offboarding')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:tenant:lifecycle:manage')
  async startOffboarding(
    @Param('tenant_id', new ParseUUIDPipe()) tenant_id: string,
    @Body() body: StartOffboardingRequestDto,
    @AuthContext() authCtx: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<TenantLifecycleActionResponseDto> {
    this.assertConsumerIsPlatform(authCtx, requestId);
    const r = await this.tenantSvc.transitionTenantStatus({
      tenant_id,
      to: 'OFFBOARDING',
      actor_id: authCtx.sub,
      actor_type: 'user',
      source: 'platform_console',
      reason_code: body.reasonCode,
      reason_text: body.reasonText,
      retention_policy_code: body.retentionPolicyCode,
      close_at: new Date(body.closeAt),
      request_id: requestId,
    });
    return { tenant_id, from: r.from, to: r.to, status: r.to, changed: r.changed };
  }

  @Post('tenants/:tenant_id/close')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('platform:tenant:lifecycle:manage')
  async closeTenant(
    @Param('tenant_id', new ParseUUIDPipe()) tenant_id: string,
    @Body() body: CloseTenantRequestDto,
    @AuthContext() authCtx: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<TenantLifecycleActionResponseDto> {
    this.assertConsumerIsPlatform(authCtx, requestId);
    const r = await this.tenantSvc.transitionTenantStatus({
      tenant_id,
      to: 'CLOSED',
      actor_id: authCtx.sub,
      actor_type: 'user',
      source: 'platform_console',
      reason_code: body.reasonCode,
      reason_text: body.reasonText,
      request_id: requestId,
    });
    return { tenant_id, from: r.from, to: r.to, status: r.to, changed: r.changed };
  }

  @Post('admins/invitations')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('platform:admin:invite')
  async invitePlatformAdmin(
    @Body() body: InvitePlatformAdminRequestDto,
    @AuthContext() authCtx: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<InviteUserResponseDto> {
    this.assertConsumerIsPlatform(authCtx, requestId);
    const result = await this.invitations.invitePlatformAdmin({
      email: body.email,
      display_name: body.display_name ?? null,
      actor_user_id: authCtx.sub,
      request_id: requestId,
    });
    return result;
  }

  private assertConsumerIsPlatform(
    authCtx: AuthContextType,
    requestId: string,
  ): void {
    // The DDR §13.1 tripwire app-side: a tenant token (consumer_type ∈
    // {recruiter, portal, ingestion}) cannot satisfy a platform route.
    // The scope-namespace partition + the JwtAuthGuard already guarantee
    // that only tokens with platform:* scopes pass RolesGuard; this
    // check is the explicit defense-in-depth on the consumer_type axis.
    if (authCtx.consumer_type !== 'platform') {
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        'Platform routes require consumer_type=platform',
        403,
        {
          requestId,
          details: {
            reason: 'tier_mismatch',
            consumer_type: authCtx.consumer_type,
          },
        },
      );
    }
  }
}

// Platform-Console Increment-2 PR-2 (G1) — map an identity AuditEventRow to the
// operator audit DTO (created_at → ISO string; raw event_payload preserved).
function toPlatformAuditEvent(row: AuditEventRow): PlatformTenantAuditEventDto {
  return {
    event_type: row.event_type,
    created_at: row.created_at.toISOString(),
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    event_payload: row.event_payload,
  };
}
