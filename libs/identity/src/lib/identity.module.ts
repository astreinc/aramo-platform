import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { CommonModule, createAramoLogger } from '@aramo/common';
import { EntitlementModule } from '@aramo/entitlement';

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
@Module({
  imports: [AuthModule, AuthorizationModule, CommonModule, EntitlementModule],
  controllers: [D4aController],
  providers: [
    PrismaService,
    IdentityRepository,
    TenantRepository,
    RoleRepository,
    IdentityAuditRepository,
    IdentityAuditService,
    IdentityService,
    TenantService,
    RoleService,
    // AUTHZ-D4a — team-model substrate (Axis-1 hierarchy + Axis-2 pods).
    ManagementEdgeRepository,
    ManagementEdgeService,
    TeamRepository,
    TeamService,
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
  ],
})
export class IdentityModule {}
