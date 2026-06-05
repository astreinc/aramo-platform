import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import {
  TenantSettingService,
  type TenantSettingsView,
} from '@aramo/settings';

// TenantSettingsController — Settings S1, the first consumer of the
// seeded-but-unused `tenant:admin:settings` scope (AUTHZ-1 catalog
// addition).
//
// Lives in apps/api (NOT in libs/settings) so the leaf-lib invariant on
// libs/settings holds: the lib imports only @aramo/common, while the
// guard-chain dependencies (@aramo/auth + @aramo/authorization +
// @aramo/entitlement) live at the application boundary that wires them.
// This mirrors the D5 field-mask interceptor placement (terminal lib +
// app-level cross-cutting wire).
//
// Guard chain (the A2 pattern, verbatim — matches D4aController):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('core')   — class-level (tenant axis); `core` is the
//                                  baseline tenant capability (every tenant
//                                  has it by virtue of being a tenant) —
//                                  settings is a tenant-foundation, not an
//                                  ATS-feature, so the gate is permissive
//                                  to the capability axis.
//   @RequireScopes('tenant:admin:settings')   — route-level (scope axis);
//                                                tenant_admin only per the
//                                                AUTHZ-1 catalog comment.
//
// Implicit-tenant pattern (Gate-5 Ruling 3): the response is scoped to the
// authenticated tenant via `authContext.tenant_id`, NOT a URL `{tenantId}`
// path parameter the caller could override. Per-tenant isolation is the
// ambient `WHERE tenant_id = authContext.tenant_id` baked into the
// repository (the load-bearing foundation-proof — tenant A's rows are
// invisible to tenant B's getAll).
//
// READ-ONLY in S1 (Gate-5 Ruling 3 — the write path lands with S2). Only
// the `GET` verb is wired here; no `PATCH` / `POST` / `PUT` / `DELETE`. S2's
// pricing-model write surface defines the audit-event shape + the per-key
// validator pattern; building a generic write surface in S1 would speculate
// both.
@Controller('v1/tenant')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class TenantSettingsController {
  constructor(private readonly tenantSettings: TenantSettingService) {}

  // GET /v1/tenant/settings — return the materialized per-tenant settings
  // view (every known-key mapped to its row-value-or-default). In S1 the
  // `KNOWN_SETTINGS` registry is EMPTY, so the body is literally `{}` for
  // every tenant; the shape lights up as S2+ register their first keys.
  @Get('settings')
  @RequireScopes('tenant:admin:settings')
  async getTenantSettings(
    @AuthContext() authContext: AuthContextType,
  ): Promise<TenantSettingsView> {
    return this.tenantSettings.getAll(authContext.tenant_id);
  }
}
