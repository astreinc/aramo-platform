import { Module } from '@nestjs/common';
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
import { TenantProfileController } from './tenant-profile/tenant-profile.controller.js';
import { TenantProfileService } from './tenant-profile/tenant-profile.service.js';
import { RoleCatalogController } from './role-catalog/role-catalog.controller.js';
import { RoleCatalogService } from './role-catalog/role-catalog.service.js';
import { SitesController } from './sites/sites.controller.js';
import { SitesService } from './sites/sites.service.js';
import { SiteRepository } from './sites/site.repository.js';
import { RoleBundleValidator } from './tenant-user/role-bundle-validator.js';

// IdentityCoreModule — the SHARED identity read surface (Auth-Hardening
// IdentityModule-Split Directive v1.0, Option c).
//
// THE SPLIT'S LOAD-BEARING PROPERTY: this module carries everything that any
// module OUTSIDE the apps/api invite/role surface consumes — IdentityService,
// IdentityAuditService, TenantService, RoleService, the repositories, and the
// D4a/audit/profile/sites/role-catalog tenant surfaces — but it carries NONE of
// the invite-saga surface: NO TENANT_COGNITO_PORT, NO AUDIT_FINANCIALS_GATE, NO
// TenantUserLifecycleService, NO TenantUserManagementController. Those live ONLY
// in the forRoot-bound IdentityModule (apps/api only).
//
// WHY: under NestJS 11's default ByReferenceModuleOpaqueKeyFactory, a STATIC
// `imports: [IdentityModule]` (keyed by the class) and a DYNAMIC
// `IdentityModule.forRoot(...)` (keyed by the returned object) are TWO module
// instances. When the consumer (TenantUserLifecycleService) + its controller
// lived in the @Module decorator shared by both instances, the static
// (stub-bound) instance — pulled in earliest by CompanyModule — won the invite
// route and resolved StubTenantCognitoAdapter (→ COGNITO_PROVISION_FAILED), even
// though forRoot bound the real adapter on the other instance. The "last-wins
// merge into module scope" premise of the forRoot fixes is false across two
// scopes. This module removes the precondition: the five external importers
// (company, visibility, task-via-forRoot-imports, auth-service, platform-admin)
// import THIS module statically — a single class-keyed instance with no port to
// leak — and the invite consumer exists in exactly one instance.
//
// This module is purely STATICALLY imported (no forRoot of its own), so it is
// always the same class-keyed instance across the graph — never a second copy.
@Module({
  imports: [AuthModule, AuthorizationModule, CommonModule, EntitlementModule],
  controllers: [
    D4aController,
    // Settings Rebuild Directive 2 — tenant audit-log read surface
    // (GET /v1/tenant/audit-events, audit:read).
    AuditController,
    // Settings Rebuild Directive 3 — tenant profile (GET/PATCH
    // /v1/tenant/profile).
    TenantProfileController,
    // Settings Rebuild Directive 4 — sites/branches CRUD
    // (CRUD /v1/tenant/sites, tenant:admin:sites).
    SitesController,
    // Settings Rebuild Directive 5 — roles-catalog read (GET
    // /v1/tenant/roles-catalog).
    RoleCatalogController,
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
    // Settings S3a — RoleBundleValidator hosts the shared D5
    // union-non-invertibility check. It is injected by IdentityService (the D5
    // check moved into the three membership-role-write methods), so it stays in
    // the shared module; platform-admin also imports it directly. It does NOT
    // depend on either invite port.
    RoleBundleValidator,
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
    // AUTHZ-D4a — exported for cross-lib consumption (libs/company D4a writes
    // emit audit events via IdentityAuditService; libs/visibility reads
    // ManagementEdge + Team for the visibility cascade).
    ManagementEdgeRepository,
    ManagementEdgeService,
    TeamRepository,
    TeamService,
    RoleBundleValidator,
  ],
})
export class IdentityCoreModule {}
