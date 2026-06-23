import { DynamicModule, Module, Type } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { CommonModule, createAramoLogger } from '@aramo/common';
import { EntitlementModule } from '@aramo/entitlement';

import { AuditController } from './audit/audit.controller.js';
import { AuditQueryService } from './audit/audit-query.service.js';
import { IdentityAuditRepository } from './audit/identity-audit.repository.js';
import { IdentityAuditService } from './audit/identity-audit.service.js';
import { D4aController } from './d4a.controller.js';
import { IdentityRepository } from './identity.repository.js';
import { IdentityService } from './identity.service.js';
import { ManagementEdgeRepository } from './management-edge.repository.js';
import { ManagementEdgeService } from './management-edge.service.js';
import { PrismaService } from './prisma/prisma.service.js';
import { RoleRepository } from './role.repository.js';
import { RoleService } from './role.service.js';
import { TeamRepository } from './team.repository.js';
import { TeamService } from './team.service.js';
import { TenantRepository } from './tenant.repository.js';
import { TenantService } from './tenant.service.js';
// Settings Rebuild Directive 3 — tenant profile read/write.
import { TenantProfileController } from './tenant-profile/tenant-profile.controller.js';
import { TenantProfileService } from './tenant-profile/tenant-profile.service.js';
// Settings Rebuild Directive 5 — roles-catalog read (closes the FE hand-mirror).
import { RoleCatalogController } from './role-catalog/role-catalog.controller.js';
import { RoleCatalogService } from './role-catalog/role-catalog.service.js';
// Settings Rebuild Directive 4 — sites/branches CRUD + hierarchy.
import { SitesController } from './sites/sites.controller.js';
import { SitesService } from './sites/sites.service.js';
import { SiteRepository } from './sites/site.repository.js';
// Settings S3a — tenant-user lifecycle (invite + disable).
import { RoleBundleValidator } from './tenant-user/role-bundle-validator.js';
import {
  StubTenantCognitoAdapter,
  TENANT_COGNITO_PORT,
  type TenantCognitoPort,
} from './tenant-user/tenant-cognito.port.js';
import { TenantUserLifecycleService } from './tenant-user/tenant-user-lifecycle.service.js';
import { TenantUserManagementController } from './tenant-user/tenant-user-management.controller.js';
// Settings S4 — auditor_with_financials GATE precondition port.
import {
  AUDIT_FINANCIALS_GATE,
  StubAuditFinancialsGateAdapter,
} from './tenant-user/audit-financials-gate.port.js';

// Per directive §3 dependency direction: libs/auth/ may consume @aramo/identity
// types, but libs/identity/ does not import @aramo/auth. CommonModule is fine
// (AramoError and shared utilities sit there).
//
// PR-8.0a-Reground §7 amendment: IdentityAuditService is added to providers
// and exports (services are the public surface; IdentityAuditRepository
// remains internal).
// M4-close HK-PR-4 — AramoLogger provider for IdentityAuditService
// (Style A constructor DI; mirrors libs/submittal PR-9 PoC pattern).
//
// AUTHZ-2: no provider changes. IdentityService + TenantService gained
// write methods (createUserFromInvitation / provisionTenant) but the
// provider wiring is the same — the new dependencies (IdentityAuditService
// on TenantService, IdentityAuditService on IdentityService) were already
// available in the module since AuditService was registered for the
// auth-service session pipeline.
//
// AUTHZ-D4a: introduces a tenant-facing controller (D4aController) for the
// Axis-1 (management edges) + Axis-2 identity-side (Team + TeamMembership)
// mechanisms. This adds Auth/Authorization/Entitlement to IdentityModule's
// imports — no cycle is introduced because none of these libs import
// @aramo/identity (the original directive's no-import-back rule was about
// auth's foundational consumption of identity TYPES, which the controller
// guard chain does not invert: the controller IS the tenant-facing surface
// where guards are first applied to identity-write operations).
// Options for IdentityModule.forRoot — the composition-root entry point.
// cognitoAdapter is the live TenantCognitoPort implementation (apps/api's
// AWS-SDK-backed TenantCognitoAdapter). Required: TypeScript rejects
// forRoot({}) at compile time, so a real-adapter omission can never
// silently degrade to the stub.
export interface IdentityModuleOptions {
  cognitoAdapter: Type<TenantCognitoPort>;
}

@Module({
  imports: [AuthModule, AuthorizationModule, CommonModule, EntitlementModule],
  controllers: [
    D4aController,
    // Settings Rebuild Directive 2 — the tenant audit-log read surface
    // (GET /v1/tenant/audit-events, audit:read). Lives here because it
    // reads the IdentityAuditEvent model owned by this lib.
    AuditController,
    // Settings Rebuild Directive 3 — tenant profile (GET/PATCH
    // /v1/tenant/profile, reuses tenant:admin:settings). Reads/writes the
    // Tenant model owned by this lib.
    TenantProfileController,
    // Settings Rebuild Directive 4 — sites/branches CRUD (CRUD
    // /v1/tenant/sites, tenant:admin:sites). Reads/writes the Site model
    // owned by this lib.
    SitesController,
    // Settings Rebuild Directive 5 — roles-catalog read (GET
    // /v1/tenant/roles-catalog, reuses tenant:admin:user-manage). Closes the
    // FE hand-mirror drift; the seed/DB is the single source.
    RoleCatalogController,
    // Settings S3a — tenant-tier user lifecycle endpoints (invite +
    // disable). Lives here (parallel to D4aController) per the Settings
    // charter §4.2 "user-management home = libs/identity"; the Cognito
    // cross-store reach is via TenantCognitoPort (no AWS-SDK edge into
    // libs/identity).
    TenantUserManagementController,
  ],
  providers: [
    PrismaService,
    IdentityRepository,
    TenantRepository,
    RoleRepository,
    IdentityAuditRepository,
    IdentityAuditService,
    AuditQueryService,
    TenantProfileService,
    RoleCatalogService,
    SitesService,
    SiteRepository,
    IdentityService,
    TenantService,
    RoleService,
    // AUTHZ-D4a — team-model substrate (Axis-1 hierarchy + Axis-2 pods).
    ManagementEdgeRepository,
    ManagementEdgeService,
    TeamRepository,
    TeamService,
    // Settings S3a — tenant-user lifecycle providers. RoleBundleValidator
    // hosts the shared D5 union-non-invertibility check (a thin consumer
    // of @aramo/field-masking's assertNonInvertibleBundle; the field-
    // masking lib remains the single owner of the non-invertibility
    // math). The TENANT_COGNITO_PORT binding HERE is the plain-import
    // default — StubTenantCognitoAdapter (throws on first call). It is
    // bound IN-SCOPE so the four non-cognito consumers (auth-service,
    // platform-admin, company, visibility) that import IdentityModule
    // plainly can construct TenantUserLifecycleService; if any of them
    // ever invokes the port it fails LOUD, never fake-succeeds.
    //
    // apps/api owns the live AWS-SDK adapter and imports via
    // IdentityModule.forRoot({ cognitoAdapter }) (see forRoot below),
    // which appends a same-token provider to THIS module's own scope
    // (last-wins) so the sole consumer resolves the real adapter. The
    // earlier defect was an AppModule-scoped override that never reached
    // IdentityModule's scope (NestJS DI is per-module hierarchical, not
    // global last-wins; IdentityModule is not @Global). Tests inject a
    // mock implementation directly via overrideProvider.
    RoleBundleValidator,
    TenantUserLifecycleService,
    {
      provide: TENANT_COGNITO_PORT,
      useClass: StubTenantCognitoAdapter,
    },
    // Settings S4 — AUDIT_FINANCIALS_GATE default binding. The stub
    // throws on first call; apps/api OVERRIDES this binding with the
    // TenantSettingService-backed adapter (last-wins, mirrors the
    // TENANT_COGNITO_PORT precedent). Tests inject a mock directly.
    {
      provide: AUDIT_FINANCIALS_GATE,
      useClass: StubAuditFinancialsGateAdapter,
    },
    {
      provide: 'IdentityAuditServiceLogger',
      useFactory: () => createAramoLogger(IdentityAuditService.name),
    },
  ],
  exports: [
    IdentityService,
    TenantService,
    RoleService,
    IdentityAuditService,
    IdentityRepository,
    TenantRepository,
    // AUTHZ-D4a — export for cross-lib consumption (libs/company D4a writes
    // emit audit events via IdentityAuditService; the D4a team services are
    // exported for direct testing).
    ManagementEdgeRepository,
    ManagementEdgeService,
    TeamRepository,
    TeamService,
    // Settings S3a — export the lifecycle service + the validator + the
    // Cognito port token. The token export lets apps/api re-register the
    // provider against the live AWS-SDK adapter (overrides the stub
    // bound above).
    RoleBundleValidator,
    TenantUserLifecycleService,
  ],
})
export class IdentityModule {
  // Two-entry-point dynamic module (Auth-Cognito-Binding-Fix v1.0).
  //
  // forRoot is for the composition root that OWNS the real Cognito
  // adapter — apps/api ONLY. It returns a DynamicModule that NestJS
  // MERGES with the @Module decorator above: the dynamic provider for
  // TENANT_COGNITO_PORT is appended to this module's own providers, so
  // it shadows the StubTenantCognitoAdapter default (last-wins within a
  // single module's scope) — and crucially binds IN IdentityModule's
  // scope, which is where TenantUserLifecycleService (a provider of this
  // module) resolves the token. cognitoAdapter is REQUIRED — omission is
  // a compile error, never a silent runtime fallback.
  //
  // The four non-cognito importers keep the plain `IdentityModule`
  // import (unchanged) and resolve the in-scope stub default.
  static forRoot(options: IdentityModuleOptions): DynamicModule {
    return {
      module: IdentityModule,
      providers: [
        {
          provide: TENANT_COGNITO_PORT,
          useClass: options.cognitoAdapter,
        },
      ],
    };
  }
}
