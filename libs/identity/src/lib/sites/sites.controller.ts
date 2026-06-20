import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { IdentityAuditService } from '../audit/identity-audit.service.js';

import { SitesService } from './sites.service.js';
import type { SiteView } from './sites.view.js';

// Settings Rebuild Directive 4 — the sites/branches CRUD surface.
//
// Guard chain (the tenant-admin pattern, verbatim — matches
// TenantProfileController / TenantSettingsController / AuditController):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('core')                — class-level (tenant axis)
//   @RequireScopes('tenant:admin:sites')      — route-level. DEDICATED scope
//     (Lead ruling): sites/branches are org STRUCTURE, separable from config
//     (settings) and legal identity (profile). Seeded to tenant_admin +
//     tenant_owner ONLY.
//
// IMPLICIT-TENANT PATTERN: tenant_id derives ONLY from authContext.tenant_id —
// never from the URL or body. Every read/write is keyed on the JWT tenant, so
// a tenant_admin in tenant A can never read, edit, deactivate, or delete a
// site in tenant B (a foreign id simply 404s).
//
// AUDIT (the app-layer two-call seam): the controller injects both the sites
// service AND IdentityAuditService and emits identity.site.{created,updated,
// deactivated} only when state actually changed (no-op-no-audit). Payloads
// carry ids + changed field NAMES — no sensitive values.
//
// DELETE semantics (Lead ruling + stated default): hard-delete is GUARDED —
// a site referenced by members or with child branches returns 400
// (reason: site_in_use); the operator deactivates instead. Deactivate is the
// reversible soft path; hard-delete only removes a truly-unused site (no
// audit event — the three events cover created/updated/deactivated).
@Controller('v1/tenant/sites')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class SitesController {
  constructor(
    private readonly sites: SitesService,
    private readonly audit: IdentityAuditService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('tenant:admin:sites')
  async list(
    @AuthContext() authContext: AuthContextType,
  ): Promise<{ items: SiteView[] }> {
    const items = await this.sites.list(authContext.tenant_id);
    return { items };
  }

  @Get(':site_id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('tenant:admin:sites')
  async get(
    @AuthContext() authContext: AuthContextType,
    @Param('site_id', new ParseUUIDPipe()) siteId: string,
    @RequestId() requestId: string,
  ): Promise<SiteView> {
    return this.sites.get(authContext.tenant_id, siteId, requestId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('tenant:admin:sites')
  async create(
    @AuthContext() authContext: AuthContextType,
    @Body() body: Record<string, unknown>,
    @RequestId() requestId: string,
  ): Promise<SiteView> {
    const { view, createdFields } = await this.sites.create({
      tenantId: authContext.tenant_id,
      body: body ?? {},
      requestId,
    });
    await this.audit.writeEvent({
      event_type: 'identity.site.created',
      actor_type: 'user',
      actor_id: authContext.sub,
      tenant_id: authContext.tenant_id,
      subject_id: view.id,
      payload: {
        parent_site_id: view.parent_site_id,
        created_fields: createdFields,
      },
    });
    return view;
  }

  @Patch(':site_id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('tenant:admin:sites')
  async update(
    @AuthContext() authContext: AuthContextType,
    @Param('site_id', new ParseUUIDPipe()) siteId: string,
    @Body() body: Record<string, unknown>,
    @RequestId() requestId: string,
  ): Promise<SiteView> {
    const { view, changedFields } = await this.sites.update({
      tenantId: authContext.tenant_id,
      siteId,
      body: body ?? {},
      requestId,
    });
    if (changedFields.length > 0) {
      await this.audit.writeEvent({
        event_type: 'identity.site.updated',
        actor_type: 'user',
        actor_id: authContext.sub,
        tenant_id: authContext.tenant_id,
        subject_id: view.id,
        payload: { changed_fields: changedFields },
      });
    }
    return view;
  }

  @Post(':site_id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('tenant:admin:sites')
  async deactivate(
    @AuthContext() authContext: AuthContextType,
    @Param('site_id', new ParseUUIDPipe()) siteId: string,
    @RequestId() requestId: string,
  ): Promise<SiteView> {
    const { view, changed } = await this.sites.deactivate({
      tenantId: authContext.tenant_id,
      siteId,
      requestId,
    });
    if (changed === true) {
      await this.audit.writeEvent({
        event_type: 'identity.site.deactivated',
        actor_type: 'user',
        actor_id: authContext.sub,
        tenant_id: authContext.tenant_id,
        subject_id: view.id,
        payload: {},
      });
    }
    return view;
  }

  @Post(':site_id/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('tenant:admin:sites')
  async reactivate(
    @AuthContext() authContext: AuthContextType,
    @Param('site_id', new ParseUUIDPipe()) siteId: string,
    @RequestId() requestId: string,
  ): Promise<SiteView> {
    const { view, changed } = await this.sites.reactivate({
      tenantId: authContext.tenant_id,
      siteId,
      requestId,
    });
    if (changed === true) {
      // Reactivation is an is_active change → the generic site.updated event.
      await this.audit.writeEvent({
        event_type: 'identity.site.updated',
        actor_type: 'user',
        actor_id: authContext.sub,
        tenant_id: authContext.tenant_id,
        subject_id: view.id,
        payload: { changed_fields: ['is_active'] },
      });
    }
    return view;
  }

  @Delete(':site_id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('tenant:admin:sites')
  async remove(
    @AuthContext() authContext: AuthContextType,
    @Param('site_id', new ParseUUIDPipe()) siteId: string,
    @RequestId() requestId: string,
  ): Promise<void> {
    await this.sites.remove({
      tenantId: authContext.tenant_id,
      siteId,
      requestId,
    });
  }
}
