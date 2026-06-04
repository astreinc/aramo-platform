import { Module } from '@nestjs/common';
import { CommonModule, createAramoLogger } from '@aramo/common';

import { IdentityAuditRepository } from './audit/identity-audit.repository.js';
import { IdentityAuditService } from './audit/identity-audit.service.js';
import { IdentityRepository } from './identity.repository.js';
import { IdentityService } from './identity.service.js';
import { PrismaService } from './prisma/prisma.service.js';
import { RoleRepository } from './role.repository.js';
import { RoleService } from './role.service.js';
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
@Module({
  imports: [CommonModule],
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
  ],
})
export class IdentityModule {}
