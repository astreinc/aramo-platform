import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { IdentityAuditService } from '../audit/identity-audit.service.js';

import { TenantProfileService } from './tenant-profile.service.js';
import type { TenantProfileView } from './tenant-profile.view.js';

// Settings Rebuild Directive 3 — the tenant-profile read/write surface.
//
// Guard chain (the tenant-admin pattern, verbatim — matches
// TenantSettingsController + TenantUserManagementController + AuditController):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('core')                  — class-level (tenant axis)
//   @RequireScopes('tenant:admin:profile')     — route-level. DEDICATED scope
//     (Lead ruling): tenant profile is org-legal-identity (legal name, tax/
//     registration IDs), a distinct capability from app config — kept separable
//     from tenant:admin:settings forever (no future migration) and giving the
//     D2 audit log a clean per-scope authorization story. Seeded to
//     tenant_admin + tenant_owner (same tier; functionally identical today).
//
// IMPLICIT-TENANT PATTERN: tenant_id derives ONLY from authContext.tenant_id —
// no URL/body tenant override. A tenant_admin in tenant A can never read or
// edit tenant B's profile (the repo keys every read/update on the JWT tenant).
//
// AUDIT (the S2 app-layer two-call seam): the controller injects both the
// profile service AND IdentityAuditService; on a PATCH that ACTUALLY changes a
// field it emits identity.tenant_profile.updated with the changed field NAMES
// (not values). A no-op PATCH emits nothing (no-op-no-audit).
@Controller('v1/tenant/profile')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class TenantProfileController {
  constructor(
    private readonly profile: TenantProfileService,
    private readonly audit: IdentityAuditService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('tenant:admin:profile')
  async getProfile(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<TenantProfileView> {
    return this.profile.getProfile(authContext.tenant_id, requestId);
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('tenant:admin:profile')
  async updateProfile(
    @AuthContext() authContext: AuthContextType,
    @Body() body: Record<string, unknown>,
    @RequestId() requestId: string,
  ): Promise<TenantProfileView> {
    const { view, changedFields } = await this.profile.updateProfile({
      tenantId: authContext.tenant_id,
      body: body ?? {},
      requestId,
    });
    if (changedFields.length > 0) {
      await this.audit.writeEvent({
        event_type: 'identity.tenant_profile.updated',
        actor_type: 'user',
        actor_id: authContext.sub,
        tenant_id: authContext.tenant_id,
        subject_id: authContext.tenant_id,
        payload: { changed_fields: changedFields },
      });
    }
    return view;
  }
}
