import { Controller, Get, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { RoleCatalogService } from './role-catalog.service.js';
import type { RoleCatalogView } from './role-catalog.view.js';

// Settings Rebuild Directive 5 — the roles-catalog read surface.
//
// Guard chain (the tenant-admin pattern, verbatim):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('core')                  — class-level (tenant axis)
//   @RequireScopes('tenant:admin:user-manage')  — route-level. REUSES the
//     user-management scope (Lead ruling B): the catalog is reference data
//     consumed by the RolePicker (whoever assigns roles must read it) + the
//     read-only matrix. Confirm-consumers verified — every role that opens the
//     RolePicker (tenant_admin / tenant_owner / account_manager /
//     recruiting_manager) already holds user-manage. No new scope, no seed.
//
// The returned roles are GLOBAL system roles (same rows for every tenant; no
// per-tenant custom roles) — reference data with no tenant-specific content to
// leak. IC-3 PR-8: the caller's tenant (AuthContext, never a request input)
// selects ONE partition — the E-Sign product roles appear only for a tenant
// that holds the `sign` capability (RoleCatalogService).
@Controller('v1/tenant/roles-catalog')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class RoleCatalogController {
  constructor(private readonly catalog: RoleCatalogService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('tenant:admin:user-manage')
  async list(@AuthContext() authContext: AuthContextType): Promise<{ roles: RoleCatalogView[] }> {
    return { roles: await this.catalog.getCatalog({ tenant_id: authContext.tenant_id }) };
  }
}
