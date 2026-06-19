import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import {
  AuditQueryService,
  type AuditQueryResult,
} from './audit-query.service.js';

// Settings Rebuild Directive 2 — the tenant audit-log READ surface.
//
// Guard chain (the tenant-admin pattern, verbatim — matches
// TenantUserManagementController + TenantSettingsController):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('core')        — class-level (tenant axis). NOTE: the
//     directive text said 'ats', but its own rationale ("as the other tenant-
//     admin reads do") + every tenant-admin/identity controller (settings,
//     user-manage) gate on 'core' — the identity/tenant-config tier. The audit
//     trail is an identity-domain surface, so 'core' is the correct, consistent
//     capability. Flagged for review.
//   @RequireScopes('audit:read')      — route-level (scope axis); seeded to
//     tenant_admin + tenant_owner in this PR (admin/compliance surface).
//
// IMPLICIT-TENANT PATTERN: tenant_id derives ONLY from authContext.tenant_id —
// there is NO URL/body tenant override. A tenant_admin in tenant A can never
// read tenant B's trail (the repo WHERE pins tenant_id from the JWT).
@Controller('v1/tenant/audit-events')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class AuditController {
  constructor(private readonly auditQuery: AuditQueryService) {}

  // GET /v1/tenant/audit-events
  //   ?limit=<int>            (optional — default 50, max 100)
  //   ?cursor=<opaque>        (optional — keyset, most-recent-first)
  //   ?actor_id=<uuid>        (optional)
  //   ?event_type=<closed set>(optional — one of EVENT_TYPES)
  //   ?subject_id=<uuid>      (optional — the entity the event concerns)
  //   ?from=<iso> ?to=<iso>   (optional — created_at range; compose AND)
  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('audit:read')
  async list(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('actor_id') actor_id?: string,
    @Query('event_type') event_type?: string,
    @Query('subject_id') subject_id?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<AuditQueryResult> {
    return this.auditQuery.query({
      tenant_id: authContext.tenant_id,
      viewerScopes: authContext.scopes,
      requestId,
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
      ...(actor_id === undefined ? {} : { actor_id }),
      ...(event_type === undefined ? {} : { event_type }),
      ...(subject_id === undefined ? {} : { subject_id }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    });
  }
}
